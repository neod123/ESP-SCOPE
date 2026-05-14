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
const char *hotspot_ssid = "ESP32-SCOPE";
const char *hotspot_password = "12345678";



IPAddress apIP(192, 168, 4, 1);
WebServer server(80);
WebSocketsServer ws(81);


// ========================================================
// ADC scope config
// ========================================================

#define BUFFER_SIZE 512

volatile uint16_t buffer[BUFFER_SIZE];
volatile uint16_t indexWrite = 0;

hw_timer_t *timer = NULL;
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

bool running = true;
int triggerLevel = 2000;

void sendFrame()
{
    uint16_t copy[BUFFER_SIZE];

    portENTER_CRITICAL(&mux);

    for (int i = 0; i < BUFFER_SIZE; i++)
        copy[i] = buffer[i];

    portEXIT_CRITICAL(&mux);

    String json = "[";

    for (int i = 0; i < BUFFER_SIZE; i++)
    {
        json += copy[i];
        if (i < BUFFER_SIZE - 1) json += ",";
    }

    json += "]";

    ws.broadcastTXT(json);
}

void handleRoot(){          server.send_P(200, "text/html",              scope_html);}
void handleCSS(){           server.send_P(200, "text/css",               scope_css);}
void handleJS(){            server.send_P(200, "application/javascript", scope_js);}
void handleChartJS(){       server.send_P(200, "application/javascript", chart_js);}
void handleChartPluginJS(){ server.send_P(200, "application/javascript", chartPlugin_js);}

const int MAX_STORAGE = 4;
int inputPins[MAX_STORAGE];
int numInputs = 0;

void configureInput(int pins[], int size) 
{
  numInputs = size;

  analogSetAttenuation(ADC_11db);
  analogReadResolution(12);
  for (int i = 0; i < size; i++) 
  {
    if (i < 10) 
    {
      inputPins[i] = pins[i];
      pinMode(inputPins[i], INPUT);
    }
  }
}


//__________________________________MANGAGE IOs _________________________________________________

struct AdcMapping {
    const char* name;
    int pin;
};
// olimex 
//https://olimex.wordpress.com/wp-content/uploads/2020/04/esp32-wrover-devkit-lipo.png
const AdcMapping adcTable[] = {
    {"A0", 36}, // ADC1_CH0 GPI36
    {"A3", 39}, // ADC1_CH3 GPI39
    {"A4", 32}, // ADC1_CH4 GPIO32
    {"A5", 33}, // ADC1_CH5 GPIO33
    {"A6", 34}, // ADC1_CH6 GPI34
    {"A7", 35},  // ADC1_CH7 GPI35

    {"GPI36", 36}, // ADC1_CH0 GPI36
    {"GPI39", 39}, // ADC1_CH3 GPI39
    {"GPIO32", 32}, // ADC1_CH4 GPIO32
    {"GPIO33", 33}, // ADC1_CH5 GPIO33
    {"GPI34", 34}, // ADC1_CH6 GPI34
    {"GPI35", 35}  // ADC1_CH7 GPI35

};

// Fonction pour récupérer le GPIO à partir du nom "Axx"
int getGpioFromName(String name) {
    char buf[name.length() + 1];

    name.toCharArray(buf, sizeof(buf));

    for (const auto& item : adcTable) {
        if (strcmp(item.name, buf) == 0) return item.pin;
    }
    return -1; 
}


//________________________________________________________________________________________


void handleCommand()
{
    String uri = server.uri();

    if (!uri.startsWith("/api/cmd/"))
    {
        server.send(404, "text/plain", "Not found");
        return;
    }

    Serial.println("cmd  : " + uri);

    // Remove prefix
    String cmd =  uri.substring(strlen("/api/cmd/"));

    Serial.println("cmd  : " + cmd);

    int p1 = cmd.indexOf('/');

    if (p1 < 0 )
    {
        server.send(400, "text/plain", "Invalid command");
        return;
    }

    server.send(200, "text/plain", "OK");

    String action =  cmd.substring(0, p1);
    String value =   cmd.substring(p1 + 1);

    Serial.println("Action : " + action);
    Serial.println("Value  : " + value);

    // value:   GPIO32;GPIO33;
    int  myPins[MAX_STORAGE] ;
    int pinCount = 0;
    while (value.indexOf(';') != -1 && pinCount < MAX_STORAGE) 
    {
        int separatorIndex = value.indexOf(';');
        String segment = value.substring(0, separatorIndex);
        myPins[pinCount++] = getGpioFromName(segment) ;
        value = value.substring(separatorIndex + 1);
    }

    for (int i = 0; i < pinCount; i++) 
        Serial.printf("GPIO extract : %d\n", myPins[i]);
    
  configureInput(myPins, pinCount);
}

void redirect()
{
    server.sendHeader("Location", String("http://") + apIP.toString(), true);
    server.send(302, "text/plain", "");
}


void onWsEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t len)
{
    if (type == WStype_CONNECTED)
    {
        Serial.println("WS client connected");
    }
}


void setup()
{
    sleep(1);
    Serial.begin(9600);
    if(hotspot)
    {
        WiFi.mode(WIFI_AP);
        WiFi.softAP(hotspot_ssid, hotspot_password);
        Serial.println(WiFi.softAPIP());
    }
    else
    {
        WiFi.mode(WIFI_STA);
        WiFi.begin(WIFI_SSID, WIFI_PASS);

        Serial.println(WiFi.localIP()); 
    }

    // HTTP routes
    server.on("/",               handleRoot);
    server.on("/scope.css",      handleCSS);
    server.on("/scope.js",       handleJS);
    server.on("/chart.js",       handleChartJS);
    server.on("/chartPlugin.js", handleChartPluginJS);

    server.on("/api/cmd",     HTTP_GET, handleCommand);

    server.onNotFound(handleCommand);
    server.begin();
    ws.begin();
    ws.onEvent(onWsEvent);
}



void loop()
{
    server.handleClient();
    ws.loop();

    static uint32_t last = 0;

    if (millis() - last > 100)
    {
      last = millis();



      String payload = "ADC;" + String(millis());

      for (int i = 0; i < numInputs; i++) 
        payload += ";" + String(analogRead(inputPins[i]));
      
      Serial.println(payload);

      ws.broadcastTXT(payload);

    }
}