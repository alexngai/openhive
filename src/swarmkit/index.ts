export { SwarmKitConfigManager } from './manager.js';
export { ProjectRegistry } from './project-registry.js';
export {
  getSharedSettingsStatus,
  propagateSharedSetting,
} from './shared-settings.js';
export {
  scaffoldProjectPackage,
  scaffoldGlobalPackage,
  isPackageInitialized,
  getProjectInitPackages,
  getGlobalInitPackages,
} from './scaffolding.js';
export type {
  PackageScope,
  PackageConfigResponse,
  IntegrationResponse,
  SwarmKitState,
  DoctorCheckResult,
  SharedSettingStatus,
  PropagationResult,
} from './types.js';
export type {
  ScaffoldResult,
  ScaffoldOptions,
} from './scaffolding.js';
