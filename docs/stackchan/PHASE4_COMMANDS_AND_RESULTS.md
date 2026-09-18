# Phase 4 命令与结果摘要

本文件只记录可复核的命令类别和结果，不包含账号、令牌、Memory 数据或原始音视频。

## Build

    idf.py build
    Generated build/stack-chan.bin
    stack-chan.bin binary size 0x25fdb0 bytes
    Project build complete

## Deploy

    python scripts/stackchan/deploy-ota1-app.py --port COM5 --image <volume90-build>/firmware/build/stack-chan.bin --evidence-dir <private-evidence-dir>

结果：

    OTA1_IMAGE_BYTES=2489776
    OTA0_APP_WRITES=0
    OTA1_WRITE_VERIFIED=YES
    OTA1_FIRST_BOOT_VALIDATED=YES

## Live Bridge

    GET /healthz                 -> 200
    GET /v1/body/state           -> 200
    POST /v1/body/control speak  -> 200 / device speaker ACK ok=true

## 端到端

    camera JPEG -> /api/pet/upload -> /api/pet/chat/start(attachmentId)
    mic PCM -> local Vosk -> /api/pet/chat/start -> local System.Speech -> speaker
