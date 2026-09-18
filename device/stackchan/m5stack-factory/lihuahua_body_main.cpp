// LiHuahua entry point: reuse board drivers, never launch cloud AI or App Center.
#include <hal/hal.h>
#include <mooncake.h>
#include <mooncake_log.h>
#include "apps/app_lihuahua_body/lihuahua_body_app.h"
extern "C" void app_main(void) {
    mclog::set_level(mclog::level_info);
    GetHAL().init();
    int app=mooncake::GetMooncake().installApp(std::make_unique<LiHuahuaBodyApp>());
    mooncake::GetMooncake().update();
    mooncake::GetMooncake().openApp(app);
    while(true) {
        GetHAL().feedTheDog();
        GetHAL().updateHeapStatusLog();
        mooncake::GetMooncake().update();
    }
}
