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

#include "image_provider.h"

#ifndef ARDUINO_EXCLUDE_CODE

#include "Arduino.h"
#include <TinyMLShield.h>

// Capture one camera frame, publish a preview to the web app, and fill the
// TensorFlow input tensor with the same downsampled grayscale image.
TfLiteStatus GetImage(tflite::ErrorReporter* error_reporter, int image_width,
                      int image_height, int channels, int8_t* image_data) {

  static byte data[176 * 144]; // Receiving QCIF grayscale from camera = 176 * 144 * 1

  static bool g_is_camera_initialized = false;
  static bool serial_is_initialized = false;

  // Initialize camera if necessary
  if (!g_is_camera_initialized) {
    if (!Camera.begin(QCIF, GRAYSCALE, 5, OV7675)) {
      TF_LITE_REPORT_ERROR(error_reporter, "Failed to initialize camera!");
      return kTfLiteError;
    }
    g_is_camera_initialized = true;
  }

  // Read camera data
  Camera.readFrame(data);

  // int min_x = (176 - 96) / 2;
  // int min_y = (144 - 96) / 2;
  int index = 0;

  // Crop 96x96 image. This lowers FOV, ideally we would downsample but this is simpler. 
  // for (int y = min_y; y < min_y + 96; y++) {
  //   for (int x = min_x; x < min_x + 96; x++) {
  //     image_data[index++] = static_cast<int8_t>(data[(y * 176) + x] - 128); // convert TF input image to signed 8-bit
  //   }
  // }

  // Stream a plain-text PGM preview between markers. Node buffers these lines
  // and forwards the image to the browser over Socket.IO.
  Serial.println("IMAGE_START");
  Serial.println("P2");
  Serial.println("64 64");
  Serial.println("255");

  // Reuse the same 176x144 -> 64x64 mapping that feeds the model so the UI
  // preview matches what the classifier actually saw.
  for (int y = 0; y < 64; y++) {
    for (int x = 0; x < 64; x++) {
      int src_x = x * 176 / 64;
      int src_y = y * 144 / 64;
      int pixel = data[(src_y * 176) + src_x];
      Serial.print(pixel);

      if (!(x == 63 && y == 63)) {
        Serial.print(" ");
      }
    }
    Serial.println();
  }

  Serial.println("IMAGE_END");

  // Fill the quantized int8 model input. The trained model expects 64x64
  // grayscale values shifted from unsigned [0,255] into signed [-128,127].
  index = 0;

  // Downsample instead of cropping so the camera keeps the full hand in view.
  for (int y = 0; y < 64; y++) {
    for (int x = 0; x < 64; x++) {

      int src_x = x * 176 / 64;
      int src_y = y * 144 / 64;

      image_data[index++] =
        static_cast<int8_t>(data[(src_y * 176) + src_x] - 128);
    }
  }

  return kTfLiteOk;
}

#endif  // ARDUINO_EXCLUDE_CODE
