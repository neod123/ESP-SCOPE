#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>

#include "web/generated/scope_html.h"
#include "web/generated/scope_css.h"
#include "web/generated/scope_js.h"
#include "web/generated/chart_js.h"
#include "web/generated/chartPlugin_js.h"


bool hotspot = false;
const char *hotspot_ssid     = "ESP32-SCOPE";
const char *hotspot_password = "12345678";

#include "env.h"
// env.h should contain:
//   const char *router_ssid     = "SSID";
//   const char *router_password = "PASSWORD";

IPAddress   apIP(192, 168, 4, 1);
WebServer          server(80);
WebSocketsServer   ws(81);


// ============================================================
// ADC input config
// ============================================================

#define MAX_STORAGE 4
int inputPins[MAX_STORAGE];
int numInputs = 0;

// Number of raw reads averaged per sample (reduces WiFi-induced noise).
#define ADC_AVG_SAMPLES 4

// Minimum µs between two consecutive measurement sets (0 = as fast as possible).
// Updated at runtime via WebSocket "SAMPLING;{delay_us}".
volatile uint32_t samplingDelayUs = 0;

uint16_t smoothRead(int pin)
{
    uint32_t sum = 0;
    for (int i = 0; i < ADC_AVG_SAMPLES; i++) sum += analogRead(pin);
    return (uint16_t)(sum / ADC_AVG_SAMPLES);
}

void configureInput(int pins[], int size)
{
    numInputs = size;
    analogSetAttenuation(ADC_11db);  // 0–3.3 V range
    analogReadResolution(12);        // 12-bit (0–4095)
    for (int i = 0; i < size && i < MAX_STORAGE; i++) {
        inputPins[i] = pins[i];
        pinMode(inputPins[i], INPUT);
    }
}

struct AdcMapping { const char *name; int pin; };
const AdcMapping adcTable[] = {
    {"A0",    36}, {"A3",    39}, {"A4",    32},
    {"A5",    33}, {"A6",    34}, {"A7",    35},
    {"GPI36", 36}, {"GPI39", 39}, {"GPIO32", 32},
    {"GPIO33",33}, {"GPI34", 34}, {"GPI35",  35},
};

int getGpioFromName(String name)
{
    char buf[name.length() + 1];
    name.toCharArray(buf, sizeof(buf));
    for (const auto &item : adcTable)
        if (strcmp(item.name, buf) == 0) return item.pin;
    return -1;
}


// ============================================================
// HTTP handlers
// ============================================================

void handleRoot()          { server.send_P(200, "text/html",              scope_html); }
void handleCSS()           { server.send_P(200, "text/css",               scope_css);  }
void handleJS()            { server.send_P(200, "application/javascript", scope_js);   }
void handleChartJS()       { server.send_P(200, "application/javascript", chart_js);   }
void handleChartPluginJS() { server.send_P(200, "application/javascript", chartPlugin_js); }

void handleCommand()
{
    String uri = server.uri();
    if (!uri.startsWith("/api/cmd/")) { server.send(404, "text/plain", "Not found"); return; }

    String cmd    = uri.substring(strlen("/api/cmd/"));
    int    p1     = cmd.indexOf('/');
    if (p1 < 0)  { server.send(400, "text/plain", "Invalid command"); return; }

    server.send(200, "text/plain", "OK");

    String action = cmd.substring(0, p1);
    String value  = cmd.substring(p1 + 1);

    Serial.println("cmd: " + action + " / " + value);

    if (action == "config") {
        int myPins[MAX_STORAGE];
        int pinCount = 0;
        while (value.indexOf(';') != -1 && pinCount < MAX_STORAGE) {
            int sep     = value.indexOf(';');
            String seg  = value.substring(0, sep);
            int gpio    = getGpioFromName(seg);
            if (gpio >= 0) myPins[pinCount++] = gpio;
            value = value.substring(sep + 1);
        }
        configureInput(myPins, pinCount);
    }
}

void redirect()
{
    server.sendHeader("Location", String("http://") + apIP.toString(), true);
    server.send(302, "text/plain", "");
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t len)
{
    if (type == WStype_CONNECTED) {
        Serial.printf("[ws] client %u connected\n", num);
    } else if (type == WStype_TEXT) {
        String msg((char*)payload, len);
        if (msg.startsWith("SAMPLING;")) {
            samplingDelayUs = (uint32_t)msg.substring(9).toInt();
            Serial.printf("[sampling] delay=%uµs\n", samplingDelayUs);
        }
    }
}


// ============================================================
// Setup
// ============================================================

void setup()
{
    sleep(1);
    Serial.begin(115200);

    if (hotspot) {
        WiFi.mode(WIFI_AP);
        WiFi.softAP(hotspot_ssid, hotspot_password);
        Serial.println("AP: " + WiFi.softAPIP().toString());
    } else {
        WiFi.mode(WIFI_STA);
        WiFi.begin(router_ssid, router_password);
        while (WiFi.status() != WL_CONNECTED) { delay(200); Serial.print('.'); }
        Serial.println("\nSTA: " + WiFi.localIP().toString());
    }

    server.on("/",               handleRoot);
    server.on("/scope.css",      handleCSS);
    server.on("/scope.js",       handleJS);
    server.on("/chart.js",       handleChartJS);
    server.on("/chartPlugin.js", handleChartPluginJS);
    server.on("/api/cmd",        HTTP_GET, handleCommand);
    server.onNotFound(handleCommand);
    server.begin();

    ws.begin();
    ws.onEvent(onWsEvent);
}


// ============================================================
// Loop — measure ADC as fast as possible, send batch every 500 ms
// ============================================================

#define MAX_BATCH_LINES 166   // hard ceiling per burst (~500/3)
#define SEND_INTERVAL_MS 50   // flush period in ms

void loop()
{
    server.handleClient();
    ws.loop();

    static uint32_t lastSend   = 0;
    static uint32_t lastSample = 0;
    static String   batch;
    static int      batchN     = 0;

    // — sample one frame per loop iteration, respecting samplingDelayUs —
    uint32_t nowUs = micros();
    if (numInputs > 0 && batchN < MAX_BATCH_LINES &&
        (samplingDelayUs == 0 || nowUs - lastSample >= samplingDelayUs))
    {
        lastSample = nowUs;
        batch += "ADC;";
        batch += nowUs;
        for (int i = 0; i < numInputs; i++) {
            batch += ';';
            batch += smoothRead(inputPins[i]);
        }
        batch += '\n';
        batchN++;
    }

    // — flush every SEND_INTERVAL_MS —
    if (millis() - lastSend >= SEND_INTERVAL_MS) {
        lastSend = millis();
        if (batchN > 0) {
            static uint32_t sendCount = 0;
            ws.broadcastTXT(batch);

            // find last complete line for display
            int end   = batch.lastIndexOf('\n', batch.length() - 2);
            int start = (end > 0) ? batch.lastIndexOf('\n', end - 1) + 1 : 0;
            String lastRow = batch.substring(start, end);
            Serial.printf("#%lu  ch:%d  n:%d  | %s\n",   ++sendCount, numInputs, batchN, lastRow.c_str());

            batch.clear();
            batch.reserve(MAX_BATCH_LINES * 40);
            batchN = 0;
        }
    }
}
