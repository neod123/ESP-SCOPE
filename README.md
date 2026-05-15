# 🚀 Web based ESP32 oscilloscope

This project turns an ESP32 into a high-performance analog signal monitor, accessible via a real-time web interface. Utilizing WebSockets, ADC data is streamed instantly to your browser, allowing for fluid data visualization without page refreshes.
## 📝 Description

The system reads analog values from the ESP32 ADC pins (dynamically configured via the web UI) and broadcasts them as formatted data frames. The integrated web interface allows users to select which GPIOs to monitor on the fly.

## Key Features:

Backend: High-speed WebSocket server running on ESP32 for ultra-low latency.
Frontend: Lightweight HTML5/JavaScript interface with optimized string parsing.
Flexibility: Dynamic pin configuration supporting the GPIO_XX; protocol.

## 🖥️ Demo

[Live demo available here](https://neod123.github.io/ESP-SCOPE/)

![Project Screenshot](Screenshot.png)

## 🛠️ Quick Start

Hardware: An ESP32 (DevKit V1, Olimex, or Wemos S2 Mini).

## Software:

Install dependencies: WebSocketsServer library.
Upload the code using VS Code + PlatformIO.

Connection: Connect to the IP address displayed in the Serial Monitor (e.g., 192.168.1.50) or on your router interface.

## 📋 Project Roadmap
### ✅ Done

- [x] Hotspot or WLAN connexion available
- [x] Initialized WebSocket server on Port 81.
- [x] ADC pin reading implementation 
- [x] Dynamic GPIOXX; string splitting and pin mapping system.
- [x] Formatted data broadcasting: ADC;value;0;0;0.
- [x] y scale should be 0 4095 fix for now
- [x] Sending mix measurements
- [x] X scaling should work
- [x] Y channel offset should display the origin and a y correponding legend
- [x] Dynamic timebase should work
- [x] Y Trigger should work
- [x] start measure on page connexion
- [x] sampling change

### ⏳ To-Do

- [ ] coockie configuration
- [ ] y trigger is not working well good

## 🔧 Tech Stack

C++ / Arduino: Embedded logic and hardware control.
JavaScript (ES6): DOM manipulation and WebSocket management.
HTML5 / CSS3: Responsive user interface.
____________________________
Built with ☕ and extensive debugging in VS Code.

