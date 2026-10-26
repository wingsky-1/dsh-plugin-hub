import {
  bundledSkillPatchContract,
  bundledSkillResolutionContract,
  distributedScriptsContract,
  readmeContract,
  resourcesSkillContract,
  skillDisclosureContract,
} from "./smoke-resources";
import { deviceEmulationContract, driverHelpContract } from "./smoke-driver";
import {
  earlyExitContract,
  readDshUrlContract,
  scriptExitContract,
  scriptTextContract,
  verifyCoreContract,
} from "./smoke-core";
import {
  auditCliContract,
  auditScriptContract,
  auditWhitelistContract,
} from "./smoke-audit-contract";
import { auditEndToEndContract } from "./smoke-audit-end-contract";
import { auditFixtureContract } from "./smoke-audit-fixtures";
import {
  installRootContract,
  noticeExtractionContract,
  settingsDocumentContract,
} from "./smoke-onboarding-api";
import { presetWelcomeNoticeContract } from "./smoke-onboarding-runtime";
import {
  driverOnboardingContract,
  onboardingDocumentationContract,
  onboardingSourceContract,
  overlayProbeContract,
  tokenRedactionContract,
  verifyOnboardingContract,
} from "./smoke-onboarding-contract";

resourcesSkillContract();
distributedScriptsContract();
bundledSkillPatchContract();
bundledSkillResolutionContract();
driverHelpContract();
deviceEmulationContract();
verifyCoreContract();
scriptTextContract();
scriptExitContract();
earlyExitContract();
skillDisclosureContract();
readmeContract();
auditWhitelistContract();
auditScriptContract();
auditCliContract();
auditEndToEndContract();
auditFixtureContract();
noticeExtractionContract();
settingsDocumentContract();
installRootContract();
presetWelcomeNoticeContract();
overlayProbeContract();
tokenRedactionContract();
readDshUrlContract();
verifyOnboardingContract();
driverOnboardingContract();
onboardingDocumentationContract();
onboardingSourceContract();
