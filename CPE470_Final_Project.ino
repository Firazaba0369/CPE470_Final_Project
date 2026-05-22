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

#include <TensorFlowLite.h> 

#include "main_functions.h"

#include "detection_responder.h"
#include "image_provider.h"
#include "model_settings.h"
#include "rps_detect_model_data.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "tensorflow/lite/version.h"

// Globals, used for compatibility with Arduino-style sketches.
namespace {
tflite::ErrorReporter* error_reporter = nullptr;
const tflite::Model* model = nullptr;
tflite::MicroInterpreter* interpreter = nullptr;
TfLiteTensor* input = nullptr;

enum RpsChoice {
  kChoicePaper = kPaperIndex,
  kChoiceRock = kRockIndex,
  kChoiceScissors = kScissorsIndex,
};

// constexpr int kButtonPin = 13;
constexpr int kWinsNeeded = 3;
constexpr int kRoundCount = 5;

const RpsChoice kArduinoChoices[kRoundCount] = {
    kChoiceRock,
    kChoiceScissors,
    kChoicePaper,
    kChoiceRock,
    kChoiceScissors,
};

int user_wins = 0;
int arduino_wins = 0;
int current_round = 0;
bool game_over = false;
bool waiting_for_release = false;
bool prompt_printed = false;

// In order to use optimized tensorflow lite kernels, a signed int8_t quantized
// model is preferred over the legacy unsigned model format. This means that
// throughout this project, input images must be converted from unisgned to
// signed format. The easiest and quickest way to convert from unsigned to
// signed 8-bit integers is to subtract 128 from the unsigned value to get a
// signed value.

// An area of memory to use for input, output, and intermediate arrays.
constexpr int kTensorArenaSize = 160 * 1024;
static uint8_t tensor_arena[kTensorArenaSize];
}  // namespace

void initializeShield();
bool readShieldButton();

const char* ChoiceName(RpsChoice choice) {
  switch (choice) {
    case kChoiceRock:
      return "ROCK";
    case kChoicePaper:
      return "PAPER";
    case kChoiceScissors:
      return "SCISSORS";
    default:
      return "UNKNOWN";
  }
}

RpsChoice HighestScoringChoice(int8_t rock_score, int8_t paper_score,
                               int8_t scissors_score) {
  if (rock_score > paper_score && rock_score > scissors_score) {
    return kChoiceRock;
  }
  if (paper_score > rock_score && paper_score > scissors_score) {
    return kChoicePaper;
  }
  return kChoiceScissors;
}

bool UserBeatsArduino(RpsChoice user_choice, RpsChoice arduino_choice) {
  return (user_choice == kChoiceRock && arduino_choice == kChoiceScissors) ||
         (user_choice == kChoicePaper && arduino_choice == kChoiceRock) ||
         (user_choice == kChoiceScissors && arduino_choice == kChoicePaper);
}

// bool ButtonWasPressed() {
//   const bool is_pressed = readShieldButton();

//   if (!is_pressed) {
//     waiting_for_release = false;
//     return false;
//   }

//   if (waiting_for_release) {
//     return false;
//   }

//   delay(30);
//   if (!readShieldButton()) {
//     return false;
//   }

//   waiting_for_release = true;
//   return true;
// }

void PrintRoundPrompt() {
  Serial.print("Round ");
  Serial.print(current_round + 1);
  Serial.print(" of ");
  Serial.print(kRoundCount);
  Serial.println(": show your choice, then press the button.");
}

void FinishGameIfNeeded() {
  if (user_wins >= kWinsNeeded) {
    Serial.println("You won the game!");
    game_over = true;
  } else if (arduino_wins >= kWinsNeeded) {
    Serial.println("Arduino won the game!");
    game_over = true;
  }
}

// The name of this function is important for Arduino compatibility.
void setup() {
  // Set up logging. Google style is to avoid globals or statics because of
  // lifetime uncertainty, but since this has a trivial destructor it's okay.
  // NOLINTNEXTLINE(runtime-global-variables)
  Serial.begin(921600); 
  
  // Wait for the serial port to connect
  while (!Serial); 

  initializeShield();

  static tflite::MicroErrorReporter micro_error_reporter;
  error_reporter = &micro_error_reporter;

  // Map the model into a usable data structure. This doesn't involve any
  // copying or parsing, it's a very lightweight operation.
  model = tflite::GetModel(g_rps_detect_model_data);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    TF_LITE_REPORT_ERROR(error_reporter,
                         "Model provided is schema version %d not equal "
                         "to supported version %d.",
                         model->version(), TFLITE_SCHEMA_VERSION);
    return;
  } 

  // Pull in only the operation implementations we need.
  // This relies on a complete list of all the ops needed by this graph.
  // An easier approach is to just use the AllOpsResolver, but this will
  // incur some penalty in code space for op implementations that are not
  // needed by this graph.
  //
  // tflite::AllOpsResolver resolver;
  // NOLINTNEXTLINE(runtime-global-variables)
  static tflite::MicroMutableOpResolver<8> micro_op_resolver;
  micro_op_resolver.AddConv2D();
  micro_op_resolver.AddMaxPool2D();
  micro_op_resolver.AddAveragePool2D();
  micro_op_resolver.AddMean();
  micro_op_resolver.AddFullyConnected();
  micro_op_resolver.AddReshape();
  micro_op_resolver.AddSoftmax();
  micro_op_resolver.AddQuantize();

  // Build an interpreter to run the model with.
  // NOLINTNEXTLINE(runtime-global-variables)
  static tflite::MicroInterpreter static_interpreter(
      model, micro_op_resolver, tensor_arena, kTensorArenaSize, error_reporter);
  interpreter = &static_interpreter;

  // Allocate memory from the tensor_arena for the model's tensors.
  TfLiteStatus allocate_status = interpreter->AllocateTensors();
  if (allocate_status != kTfLiteOk) {
    TF_LITE_REPORT_ERROR(error_reporter, "AllocateTensors() failed");
    while (1){
      delay(1000);
      Serial.println("AllocateTensors FAILED");
    }
    //return;
  }

  Serial.println("AllocateTensors OK");

  // Get information about the memory area to use for the model's input.
  input = interpreter->input(0);

  Serial.println("Rock Paper Scissors game ready.");
  PrintRoundPrompt();
  prompt_printed = true;
}

// The name of this function is important for Arduino compatibility.
void loop() {
  if (game_over) {
    while (1) {
      delay(1000);
    }
  }

  if (!prompt_printed) {
    PrintRoundPrompt();
    prompt_printed = true;
  }

  if (!readShieldButton()) {
    return;
  }

  // Get image from provider.
  if (kTfLiteOk != GetImage(error_reporter, kNumCols, kNumRows, kNumChannels,
                            input->data.int8)) {
    TF_LITE_REPORT_ERROR(error_reporter, "Image capture failed.");
    return;
  }

  // Run the model on this input and make sure it succeeds.
  if (kTfLiteOk != interpreter->Invoke()) {
    TF_LITE_REPORT_ERROR(error_reporter, "Invoke failed.");
    return;
  }

  TfLiteTensor* output = interpreter->output(0);

  // Process the inference results.
  int8_t rock_score = output->data.int8[kRockIndex];
  int8_t paper_score = output->data.int8[kPaperIndex];
  int8_t scissors_score = output->data.int8[kScissorsIndex];
  RespondToDetection(error_reporter, rock_score, paper_score, scissors_score);

  RpsChoice user_choice =
      HighestScoringChoice(rock_score, paper_score, scissors_score);
  RpsChoice arduino_choice = kArduinoChoices[current_round];

  Serial.print("You played ");
  Serial.print(ChoiceName(user_choice));
  Serial.print(". Arduino played ");
  Serial.print(ChoiceName(arduino_choice));
  Serial.println(".");

  if (user_choice == arduino_choice) {
    Serial.println("Tie. Same Arduino choice, try again.");
    prompt_printed = false;
    return;
  }

  if (UserBeatsArduino(user_choice, arduino_choice)) {
    user_wins++;
    Serial.println("You win this round.");
  } else {
    arduino_wins++;
    Serial.println("Arduino wins this round.");
  }

  Serial.print("Score - You: ");
  Serial.print(user_wins);
  Serial.print(" Arduino: ");
  Serial.println(arduino_wins);

  current_round++;
  FinishGameIfNeeded();

  if (!game_over && current_round >= kRoundCount) {
    if (user_wins > arduino_wins) {
      Serial.println("You won the game!");
    } else if (arduino_wins > user_wins) {
      Serial.println("Arduino won the game!");
    } else {
      Serial.println("Game ended in a tie.");
    }
    game_over = true;
  }

  prompt_printed = false;
}
