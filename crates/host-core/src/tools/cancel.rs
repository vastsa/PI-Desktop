//! One per-call cancellation signal for synchronous search checkpoints and
//! asynchronous subprocess I/O. No watcher threads or parallel registry.

use std::fmt;
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("tool aborted")
    }
}

impl std::error::Error for Cancelled {}

impl From<Cancelled> for (String, String) {
    fn from(error: Cancelled) -> Self {
        ("TOOL_ABORTED".into(), error.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct ToolCancellation {
    receiver: Option<watch::Receiver<bool>>,
    #[cfg(test)]
    checks_left: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
}

impl ToolCancellation {
    pub fn from_receiver(receiver: Option<watch::Receiver<bool>>) -> Self {
        Self {
            receiver,
            #[cfg(test)]
            checks_left: None,
        }
    }

    pub fn check(&self) -> Result<(), Cancelled> {
        if self
            .receiver
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
        {
            return Err(Cancelled);
        }
        #[cfg(test)]
        if let Some(checks) = &self.checks_left {
            use std::sync::atomic::Ordering;
            let mut left = checks.load(Ordering::SeqCst);
            loop {
                if left == 0 {
                    return Err(Cancelled);
                }
                match checks.compare_exchange_weak(
                    left,
                    left - 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(current) => left = current,
                }
            }
        }
        Ok(())
    }

    pub async fn cancelled(&self) {
        if let Some(mut receiver) = self.receiver.clone() {
            if receiver.wait_for(|cancelled| *cancelled).await.is_ok() {
                return;
            }
        }
        // Normal registry disposal is not a cancellation request. A stopped
        // call or host shutdown sends true before dropping its sender.
        std::future::pending::<()>().await;
    }

    #[cfg(test)]
    pub fn cancel_after(checks: usize) -> Self {
        Self {
            receiver: None,
            checks_left: Some(std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(
                checks,
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn live_signal_wakes_and_stays_cancelled() {
        let (sender, receiver) = watch::channel(false);
        let cancellation = ToolCancellation::from_receiver(Some(receiver));
        assert_eq!(cancellation.check(), Ok(()));
        sender.send(true).unwrap();
        cancellation.cancelled().await;
        assert_eq!(cancellation.check(), Err(Cancelled));
        assert_eq!(cancellation.check(), Err(Cancelled));
    }

    #[tokio::test]
    async fn normal_registry_disposal_does_not_cancel() {
        let (sender, receiver) = watch::channel(false);
        let cancellation = ToolCancellation::from_receiver(Some(receiver));
        drop(sender);
        assert_eq!(cancellation.check(), Ok(()));
        assert!(
            tokio::time::timeout(std::time::Duration::ZERO, cancellation.cancelled())
                .await
                .is_err()
        );
    }

    #[test]
    fn deterministic_checkpoint_budget_is_shared_and_latched() {
        let cancellation = ToolCancellation::cancel_after(2);
        let cloned = cancellation.clone();
        assert_eq!(cancellation.check(), Ok(()));
        assert_eq!(cloned.check(), Ok(()));
        assert_eq!(cancellation.check(), Err(Cancelled));
        assert_eq!(cloned.check(), Err(Cancelled));
    }
}
