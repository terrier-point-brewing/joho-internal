/**
 * Every alert source, in the order the dashboard and the digest list them.
 * Adding a kind of alert is one entry in one of the three section files.
 */
import type { AlertSource } from "../types";
import { PRODUCTION_SOURCES } from "./production";
import { FINANCE_SOURCES } from "./finance";
import { SETTINGS_SOURCES } from "./settings";

export const ALERT_SOURCES: AlertSource[] = [...PRODUCTION_SOURCES, ...FINANCE_SOURCES, ...SETTINGS_SOURCES];
