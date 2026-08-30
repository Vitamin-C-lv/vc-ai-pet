export const PET_POLICY = Object.freeze({hostAccess:'NONE',shellAccess:'NONE',deepSeekUsage:'NONE',dshToolAccess:'NONE',memoryDatabase:'FULLY_ISOLATED',networkAccess:'NONE_V0_1'})
export function assertPetPolicy(){if(PET_POLICY.hostAccess!=='NONE'||PET_POLICY.deepSeekUsage!=='NONE'||PET_POLICY.memoryDatabase!=='FULLY_ISOLATED')throw new Error('PET_POLICY_BROKEN');return true}
