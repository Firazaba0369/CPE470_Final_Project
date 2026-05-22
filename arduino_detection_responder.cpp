/* Copyright 2019 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/

#if defined(ARDUINO) && !defined(ARDUINO_ARDUINO_NANO33BLE)
#define ARDUINO_EXCLUDE_CODE
#endif  // defined(ARDUINO) && !defined(ARDUINO_ARDUINO_NANO33BLE)

#ifndef ARDUINO_EXCLUDE_CODE

#include "detection_responder.h"

#include "Arduino.h"

// Flash the blue LED after each inference
void RespondToDetection(tflite::ErrorReporter* error_reporter,
                        int8_t rock_score,int8_t paper_score, int8_t scissors_score) {
  static bool is_initialized = false;
  if (!is_initialized) {
    // Pins for the built-in RGB LEDs on the Arduino Nano 33 BLE Sense
    pinMode(LEDR, OUTPUT);
    pinMode(LEDG, OUTPUT);
    pinMode(LEDB, OUTPUT);
    is_initialized = true;
  }

  // Note: The RGB LEDs on the Arduino Nano 33 BLE
  // Sense are on when the pin is LOW, off when HIGH.

  // Switch the person/not person LEDs off
  // digitalWrite(LEDG, HIGH);
  // digitalWrite(LEDR, HIGH);

  // Flash the blue LED after every inference.
  // digitalWrite(LEDB, LOW);
  // delay(100);
  // digitalWrite(LEDB, HIGH);
  // RED TEST

  // Switch on the green LED when a person is detected,
  // the red when rock is detected
  if (rock_score > paper_score && rock_score > scissors_score) {
    digitalWrite(LEDR, LOW);  // ON
    digitalWrite(LEDG, HIGH);   // OFF
    digitalWrite(LEDB, HIGH);  // OFF
    Serial.println("ROCK");
    
  } 
  // Switch on the blue LED whe paper detected 
  else if (paper_score > rock_score && paper_score > scissors_score){
    digitalWrite(LEDR, HIGH);  // OFF
    digitalWrite(LEDG, LOW);   // ON (BLUE AND GREEN FLIPPED FOR SOME REASON)
    digitalWrite(LEDB, HIGH);  // OFF
    Serial.println("PAPER");
  }
  // Switch on green LED when scissors deteccted
  else {
    digitalWrite(LEDR, HIGH);  // OFF
    digitalWrite(LEDG, HIGH);   // OFF
    digitalWrite(LEDB, LOW);  // ON (BLUE AND GREEN FLIPPED FOR SOME REASON)
    Serial.println("SCISSORS");
  }

  TF_LITE_REPORT_ERROR(error_reporter, "Rock score: %d Paper score: %d Scissors score: %d",
                       rock_score, paper_score, scissors_score);
}

#endif  // ARDUINO_EXCLUDE_CODE
