use std::sync::mpsc::Sender;

/// Resolves on `SIGINT` (Ctrl+C) or `SIGTERM` on POSIX, and on Ctrl+C, `SIGBREAK` (Ctrl+Break) or the
/// console closing on Windows, then tells the dev loop to stop.
pub(crate) async fn wait(stop: Sender<()>) {
    #[cfg(unix)]
    let other = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                terminate.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(windows)]
    let other = async {
        use tokio::signal::windows::{ctrl_break, ctrl_close};
        match (ctrl_break(), ctrl_close()) {
            (Ok(mut breaks), Ok(mut closes)) => {
                tokio::select! {
                    _ = breaks.recv() => {}
                    _ = closes.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(any(unix, windows)))]
    let other = std::future::pending::<()>();
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        () = other => {}
    }
    let _ = stop.send(());
}
