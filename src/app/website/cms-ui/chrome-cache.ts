import "server-only";
import { cache } from "react";
import { loadChrome } from "./chrome";

/** One read per request however many components ask. */
export const chromeFor = cache(loadChrome);
