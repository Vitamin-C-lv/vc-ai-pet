#pragma once
#include <cstdint>
#include <string>
#include <vector>

void lihuahuaBodyIOPoll();
void lihuahuaBodyRequestCapture();
void lihuahuaBodyRequestRecord();
void lihuahuaBodyRequestTouchWake();
std::string lihuahuaBodyEndpoint(const char* path);
void lihuahuaBodyDiscover();
void lihuahuaBodySubmitWake(std::vector<int16_t>&& pcm, const char* candidate, float score);
bool lihuahuaBodyWakeStart();
void lihuahuaBodyWakeStop();
