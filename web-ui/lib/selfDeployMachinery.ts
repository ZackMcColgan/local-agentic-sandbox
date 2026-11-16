export interface SelfDeployPlanInput {
  currentImage: string;
  targetImage: string;
  healthUrl: string;
  shadowMode: true;
}

export interface SelfDeployPlan {
  shadowOnly: true;
  rollbackTarget: string;
  targetImage: string;
  healthUrl: string;
  steps: string[];
}

export function prepareSelfDeployPlan(input: SelfDeployPlanInput): SelfDeployPlan {
  return {
    shadowOnly: true,
    rollbackTarget: input.currentImage,
    targetImage: input.targetImage,
    healthUrl: input.healthUrl,
    steps: [
      `bank_rollback_target:${input.currentImage}`,
      `build_and_import:${input.targetImage}`,
      `set_image:${input.targetImage}`,
      `verify_health:${input.healthUrl}`,
      "auto_rollback_on_verify_fail",
    ],
  };
}
