use tauri::Manager;
use std::fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // ─── Log file rotation ────────────────────────────────────────────
  // Calculate the explicit log directory based on the identifier
  let mut log_dir = dirs::data_local_dir().unwrap_or_default();
  log_dir.push("xyz.hainaut.kyoquake");
  log_dir.push("logs");
  let _ = fs::create_dir_all(&log_dir);

  let latest = log_dir.join("latest.log");
  let old = log_dir.join("old.log");

  if latest.exists() {
    let _ = fs::copy(&latest, &old);
    let _ = fs::remove_file(&latest);
  }

  // ─── Panic Hook ────────────────────────────────────────────────────────
  let panic_log_path = log_dir.join("panic.log");
  std::panic::set_hook(Box::new(move |info| {
    let mut msg = String::new();
    if let Some(s) = info.payload().downcast_ref::<&str>() {
      msg.push_str(s);
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
      msg.push_str(s);
    } else {
      msg.push_str("Unknown panic");
    }
    let location = info.location().map_or("unknown location".to_string(), |l| format!("{}:{}", l.file(), l.line()));
    let panic_msg = format!("Panic occurred: '{}' at {}\n", msg, location);
    
    // Log to standard error
    eprintln!("{}", panic_msg);
    
    // Append to panic.log
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&panic_log_path) {
      let _ = file.write_all(panic_msg.as_bytes());
    }
  }));

  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Debug)
        .targets([
          tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Folder {
              path: log_dir,
              file_name: Some("latest.log".into()),
            },
          ),
          tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
          ),
        ])
        .build(),
    )
    .setup(|app| {
      // ─── Linux: remove GTK header bar ─────────────────────────────────
      #[cfg(target_os = "linux")]
      {
        use gtk::prelude::GtkWindowExt;
        let window = app.get_webview_window("main").unwrap();
        let gtk_window = window.gtk_window().unwrap();
        gtk_window.set_titlebar(None::<&gtk::Widget>);
      }

      Ok(())
    })
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
