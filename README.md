# CPE470 Final Project

**Overview**
A Rock–Paper–Scissors game that runs in a web app and plays five rounds against the Arduino (Arduino Nano 33 BLE specifically). The user turns their back to the screen, places their hand choice in front of the camera, clicks the capture button,and an on-board TinyML model determines the user's choice. The Arduino randomly selects rock, paper, scissors then displays it on the screen and the user turns around to see the result.

**Run Web App**

1. Open a terminal and `cd` into the `web-app` folder.

2. Install dependencies (run once): `npm install`

3. Set the Arduino port using `$env:ARDUINO_PORT="COM#"` with your board's COM port number and run `npm start`

4. Click the link printed in the terminal (or open **http://127.0.0.1:3000**)

