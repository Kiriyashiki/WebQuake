import { checkIsDesktop, desktopLog } from "./desktopBridge.js";

/**
 * Initializes the logging pipeline.
 * Must be called once, as early as possible in the app lifecycle.
 */
export async function initLogger() {
  if (!checkIsDesktop()) return;

  try {
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalDebug = console.debug;
    const originalLog = console.log;

    const formatArgs = (args) => {
      return args
        .map((arg) => {
          if (typeof arg === "object") {
            try {
              return JSON.stringify(arg);
            } catch (e) {
              return String(arg);
            }
          }
          return String(arg);
        })
        .join(" ");
    };

    const logToDesktop = (level, args) => {
      desktopLog(level, formatArgs(args));
    };

    console.info = (...args) => {
      originalInfo(...args);
      logToDesktop("info", args);
    };
    console.warn = (...args) => {
      originalWarn(...args);
      logToDesktop("warn", args);
    };
    console.error = (...args) => {
      originalError(...args);
      logToDesktop("error", args);
    };
    console.debug = (...args) => {
      originalDebug(...args);
      logToDesktop("debug", args);
    };
    console.log = (...args) => {
      originalLog(...args);
      logToDesktop("trace", args);
    };

    console.info("[logger] Log pipeline attached — session logs will be written to disk.");

    window.addEventListener("error", (event) => {
      console.error("[Uncaught Error]", event.error ? event.error.stack || event.error : event.message);
    });

    window.addEventListener("unhandledrejection", (event) => {
      console.error("[Unhandled Rejection]", event.reason ? event.reason.stack || event.reason : event.reason);
    });
  } catch (err) {
    console.warn("[logger] Failed to attach desktop log pipeline:", err);
  }
}
