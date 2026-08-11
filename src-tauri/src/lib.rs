use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // On Linux, remove the GTK header bar so the window manager (e.g. KDE/KWin)
      // draws its own native title bar.
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
