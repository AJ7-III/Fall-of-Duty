import type { ADSAnimationData, WeaponConfig, WeaponId } from "./WeaponTypes";
import m40a3Config from "../data/weapons/m40a3_style.json";
import m40a3AdsFrames from "../data/animations/m40a3_ads_frames.json";
import usp45Config from "../data/weapons/usp45_style.json";
import usp45AdsFrames from "../data/animations/usp45_ads_frames.json";
import mp44Config from "../data/weapons/mp44_style.json";
import mp44AdsFrames from "../data/animations/mp44_ads_frames.json";

// Weapon tuning and aim-down-sight keyframes live as data under src/data;
// this is the one place that binds a weapon id to its files.

const CONFIGS: Record<WeaponId, WeaponConfig> = {
  m40a3: m40a3Config as WeaponConfig,
  usp45: usp45Config as WeaponConfig,
  mp44: mp44Config as WeaponConfig,
};

const ADS_FRAMES: Record<WeaponId, ADSAnimationData> = {
  m40a3: m40a3AdsFrames as ADSAnimationData,
  usp45: usp45AdsFrames as ADSAnimationData,
  mp44: mp44AdsFrames as ADSAnimationData,
};

export function weaponConfig(id: WeaponId): WeaponConfig {
  return CONFIGS[id];
}

export function weaponAdsFrames(id: WeaponId): ADSAnimationData {
  return ADS_FRAMES[id];
}
