use std::fs;

/// Directory shared by the rotating session logs and the debug log.
fn get_log_dir() -> std::path::PathBuf {
  let mut log_dir = dirs::data_local_dir().unwrap_or_default();
  log_dir.push("xyz.hainaut.kyoquake");
  log_dir.push("logs");
  log_dir
}

/// User-provided local audio files, placed next to the logs folder.
fn get_audio_dir() -> std::path::PathBuf {
  let mut audio_dir = get_log_dir();
  audio_dir.pop();
  audio_dir.push("audio");
  audio_dir
}

fn is_valid_audio_file_name(name: &str) -> bool {
  let path = std::path::Path::new(name);
  if path.file_name().and_then(|value| value.to_str()) != Some(name) {
    return false;
  }

  matches!(
    path.extension()
      .and_then(|value| value.to_str())
      .map(|value| value.to_ascii_lowercase())
      .as_deref(),
    Some("wav")
      | Some("mp3")
      | Some("ogg")
      | Some("oga")
      | Some("m4a")
      | Some("aac")
      | Some("flac")
      | Some("opus")
      | Some("webm")
      | Some("weba")
  )
}

/// Lists playable audio files in the audio/ folder.
#[tauri::command]
fn list_audio_files() -> Result<Vec<String>, String> {
  let audio_dir = get_audio_dir();
  fs::create_dir_all(&audio_dir).map_err(|err| err.to_string())?;

  let mut files = Vec::new();
  let entries = fs::read_dir(&audio_dir).map_err(|err| err.to_string())?;
  for entry in entries.flatten() {
    if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
      continue;
    }
    if let Some(name) = entry.file_name().to_str() {
      if is_valid_audio_file_name(name) {
        files.push(name.to_owned());
      }
    }
  }
  files.sort_by_key(|name| name.to_ascii_lowercase());
  Ok(files)
}

/// Reads one audio file from the audio/ folder.
#[tauri::command]
fn read_audio_file(name: String) -> Result<Vec<u8>, String> {
  if !is_valid_audio_file_name(&name) {
    return Err("Invalid audio file name.".into());
  }
  fs::read(get_audio_dir().join(name)).map_err(|err| err.to_string())
}

/// Returns the absolute path of the audio/ folder.
#[tauri::command]
fn get_audio_dir_path() -> Result<String, String> {
  get_audio_dir()
    .to_str()
    .map(|value| value.to_owned())
    .ok_or_else(|| "Audio folder path is not valid UTF-8.".into())
}

/// Appends one minified JSON message to debug.log.
///
/// This file is intentionally never rotated or reset at startup; it is only
/// cleared by the user through the hidden debug options menu.
#[tauri::command]
fn debug_log(message: String) -> Result<(), String> {
  use std::io::Write;

  let log_dir = get_log_dir();
  fs::create_dir_all(&log_dir).map_err(|err| err.to_string())?;

  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(log_dir.join("debug.log"))
    .map_err(|err| err.to_string())?;

  writeln!(file, "{}", message).map_err(|err| err.to_string())
}

/// Empties debug.log without deleting it.
#[tauri::command]
fn clear_debug_log() -> Result<(), String> {
  let log_dir = get_log_dir();
  fs::create_dir_all(&log_dir).map_err(|err| err.to_string())?;
  fs::write(log_dir.join("debug.log"), "").map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // ─── Log file rotation ────────────────────────────────────────────
  // Calculate the explicit log directory based on the identifier
  let log_dir = get_log_dir();
  let _ = fs::create_dir_all(&log_dir);

  // Ensure the user-facing audio folder exists from the first launch.
  let _ = fs::create_dir_all(get_audio_dir());

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
        .max_file_size(1_000_000)
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
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      debug_log,
      clear_debug_log,
      list_audio_files,
      read_audio_file,
      get_audio_dir_path
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
