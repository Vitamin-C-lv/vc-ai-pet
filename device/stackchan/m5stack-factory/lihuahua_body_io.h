#pragma once
#include <cstdint>
#include <string>
#include <vector>

void lihuahuaBodyIOPoll();
void lihuahuaBodyRequestCapture();
void lihuahuaBodyRequestRecord();
std::string lihuahuaBodyEndpoint(const char* path);
void lihuahuaBodyDiscover();
void lihuahuaBodySubmitWake(std::vector<int16_t>&& pcm, const char* candidate);
bool lihuahuaBodyWakeStart();
void lihuahuaBodyWakeStop();
