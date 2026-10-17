"use client";

import type { ScreenKit } from "@/app/erp/_ui/kit";
import { HRMS_FLAGS, HRMS_TONES } from "@/lib/hrms/vocab";
import { hrmsLoadForm, hrmsRunAction, hrmsRunBulk, hrmsRunTool, hrmsSubmitForm } from "@/lib/actions/hrms-screens";

/** The HRMS's kit for the shared screens: its four doors, its uploads, its vocabulary. */
export const HRMS_KIT: ScreenKit = {
  runAction: hrmsRunAction,
  runBulk: hrmsRunBulk,
  submitForm: hrmsSubmitForm,
  loadForm: hrmsLoadForm,
  runTool: hrmsRunTool,
  uploadUrl: "/api/hrms/attachments",
  mapKeyUrl: "/api/hrms/map-key",
  flags: HRMS_FLAGS,
  tones: HRMS_TONES,
  place: { one: "office", many: "offices" },
};
