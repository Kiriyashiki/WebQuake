const IS_TAURI = Boolean(window.__TAURI_INTERNALS__);

/**
 * Initializes the logging pipeline.
 * Must be called once, as early as possible in the app lifecycle.
 */
export async function initLogger() {
  if (!IS_TAURI) return;

  try {
    const { info, warn, error, debug, trace } = await import("@tauri-apps/plugin-log");

    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalDebug = console.debug;
    const originalLog = console.log;

    const formatArgs = (args) => {
      return args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      }).join(" ");
    };

    console.info = (...args) => { originalInfo(...args); info(formatArgs(args)).catch(()=>{}); };
    console.warn = (...args) => { originalWarn(...args); warn(formatArgs(args)).catch(()=>{}); };
    console.error = (...args) => { originalError(...args); error(formatArgs(args)).catch(()=>{}); };
    console.debug = (...args) => { originalDebug(...args); debug(formatArgs(args)).catch(()=>{}); };
    console.log = (...args) => { originalLog(...args); trace(formatArgs(args)).catch(()=>{}); };

    console.info("[logger] Log pipeline attached — session logs will be written to disk.");

    window.addEventListener("error", (event) => {
      console.error("[Uncaught Error]", event.error ? event.error.stack || event.error : event.message);
    });

    window.addEventListener("unhandledrejection", (event) => {
      console.error("[Unhandled Rejection]", event.reason ? event.reason.stack || event.reason : event.reason);
    });
  } catch (err) {
    console.warn("[logger] Failed to attach Tauri log plugin:", err);
  }
}
