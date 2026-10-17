//! Explicit conflict choices are scoped to the exact pair the user approved.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictResolution {
    domain: String,
    entity_id: String,
    local_digest: String,
    remote_digest: String,
    choose_local: bool,
}

pub(super) fn record(
    config: &mut StoredConfig,
    bundle: &PendingBundle,
    applied: &BTreeSet<(String, String)>,
) {
    for approval in &bundle.approvals {
        let entity = &approval.entity;
        if !approval.approved || !applied.contains(&entity_key(entity)) {
            continue;
        }
        let Some(id) = conflict_base_id(&entity.entity_id) else {
            continue;
        };
        let find = |suffix: &str| {
            bundle.manifest.entities.iter().find(|candidate| {
                candidate.domain == entity.domain && candidate.entity_id == format!("{id}:{suffix}")
            })
        };
        let (Some(local), Some(remote)) = (find("local"), find("remote")) else {
            continue;
        };
        config
            .resolved_conflicts
            .retain(|value| value.domain != entity.domain || value.entity_id != id);
        config.resolved_conflicts.push(ConflictResolution {
            domain: entity.domain.clone(),
            entity_id: id.into(),
            local_digest: local.digest.clone(),
            remote_digest: remote.digest.clone(),
            choose_local: entity.entity_id.ends_with(":local"),
        });
    }
}

/// Fold only an explicitly resolved, unchanged pair. A different remote edit
/// or an already canonical remote entity must continue through three-way merge.
pub(super) fn reconcile(resolutions: &[ConflictResolution], remote: &mut RevisionManifest) -> bool {
    let mut changed = false;
    for resolution in resolutions {
        let find = |id: &str| {
            remote
                .entities
                .iter()
                .find(|entity| entity.domain == resolution.domain && entity.entity_id == id)
        };
        if find(&resolution.entity_id).is_some() {
            continue;
        }
        let (Some(local), Some(other)) = (
            find(&format!("{}:local", resolution.entity_id)),
            find(&format!("{}:remote", resolution.entity_id)),
        ) else {
            continue;
        };
        if local.digest != resolution.local_digest || other.digest != resolution.remote_digest {
            continue;
        }
        let mut chosen = if resolution.choose_local {
            local.clone()
        } else {
            other.clone()
        };
        chosen.entity_id = resolution.entity_id.clone();
        domains::refresh_digest(&mut chosen);
        remote.entities.retain(|entity| {
            entity.domain != resolution.domain
                || conflict_base_id(&entity.entity_id) != Some(&resolution.entity_id)
        });
        remote.entities.push(chosen);
        changed = true;
    }
    remote.entities.sort_by_key(entity_key);
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_does_not_choose_a_new_or_unapproved_conflict() {
        let entity = PortableEntity {
            domain: "application".into(),
            entity_id: "app:local".into(),
            label: "Preferences".into(),
            deleted: false,
            requires_approval: false,
            secret_bearing: false,
            mapping_required: false,
            digest: "local".into(),
            payload: json!({"theme":"light"}),
            resource_ids: vec![],
        };
        let mut other = entity.clone();
        other.entity_id = "app:remote".into();
        other.digest = "remote".into();
        other.payload = json!({"theme":"dark"});
        let manifest = RevisionManifest {
            format: REVISION_FORMAT.into(),
            version: 1,
            revision_id: "r".into(),
            parents: vec![],
            created_at: String::new(),
            entities: vec![entity, other],
            resource_ids: vec![],
        };
        let resolution = ConflictResolution {
            domain: "application".into(),
            entity_id: "app".into(),
            local_digest: "local".into(),
            remote_digest: "remote".into(),
            choose_local: true,
        };
        let mut remote = manifest.clone();
        assert!(!reconcile(&[], &mut remote));
        assert_eq!(remote.entities, manifest.entities);
        remote.entities[1].digest = "new-remote".into();
        assert!(!reconcile(std::slice::from_ref(&resolution), &mut remote));
        assert_eq!(remote.entities.len(), 2);
        remote = manifest;
        assert!(reconcile(std::slice::from_ref(&resolution), &mut remote));
        assert_eq!(remote.entities.len(), 1);
        assert_eq!(remote.entities[0].entity_id, "app");
        assert_eq!(remote.entities[0].payload["theme"], "light");
        assert!(!reconcile(&[resolution], &mut remote));
    }
}
