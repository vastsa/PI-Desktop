use super::domains::{
    refresh_digest, CategorySelection, LocalSnapshot, PortableEntity, RevisionManifest,
    DOMAIN_APPLICATION,
};
use anyhow::{bail, Result};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub domain: String,
    pub entity_id: String,
    pub label: String,
    pub local_digest: String,
    pub remote_digest: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct MergeResult {
    pub entities: Vec<PortableEntity>,
    pub conflicts: Vec<MergeConflict>,
}

fn key(entity: &PortableEntity) -> (String, String) {
    (entity.domain.clone(), entity.entity_id.clone())
}

fn index(manifest: Option<&RevisionManifest>) -> BTreeMap<(String, String), PortableEntity> {
    manifest
        .map(|manifest| {
            manifest
                .entities
                .iter()
                .cloned()
                .map(|entity| (key(&entity), entity))
                .collect()
        })
        .unwrap_or_default()
}

fn choose_conflict(
    local: &PortableEntity,
    remote: &PortableEntity,
) -> (PortableEntity, PortableEntity) {
    let mut local_candidate = local.clone();
    local_candidate.entity_id = format!("{}:local", local_candidate.entity_id);
    local_candidate.label = format!("{} (local)", local_candidate.label);
    let mut remote_candidate = remote.clone();
    remote_candidate.entity_id = format!("{}:remote", remote_candidate.entity_id);
    remote_candidate.label = format!("{} (remote)", remote_candidate.label);
    (local_candidate, remote_candidate)
}

fn merge_application_fields(
    base: &PortableEntity,
    local: &PortableEntity,
    remote: &PortableEntity,
) -> Option<PortableEntity> {
    if base.deleted || local.deleted || remote.deleted {
        return None;
    }
    let (Some(base_object), Some(local_object), Some(remote_object)) = (
        base.payload.as_object(),
        local.payload.as_object(),
        remote.payload.as_object(),
    ) else {
        return None;
    };
    let mut keys = BTreeSet::new();
    keys.extend(base_object.keys().cloned());
    keys.extend(local_object.keys().cloned());
    keys.extend(remote_object.keys().cloned());
    let mut merged = serde_json::Map::new();
    for key in keys {
        let base_value = base_object.get(&key);
        let local_value = local_object.get(&key);
        let remote_value = remote_object.get(&key);
        let value = if local_value == remote_value {
            local_value
        } else if local_value == base_value {
            remote_value
        } else if remote_value == base_value {
            local_value
        } else {
            return None;
        };
        if let Some(value) = value {
            merged.insert(key, value.clone());
        }
    }
    let mut result = local.clone();
    result.payload = serde_json::Value::Object(merged);
    refresh_digest(&mut result);
    Some(result)
}

/// Merge a captured local state and a remote revision against the last
/// acknowledged common base. A missing entity is meaningful only when it is
/// present in the base; callers represent that deletion as a tombstone before
/// invoking this function. This keeps category opt-out from becoming an
/// accidental remote delete.
pub fn three_way(
    base: Option<&RevisionManifest>,
    local: &RevisionManifest,
    remote: Option<&RevisionManifest>,
) -> Result<MergeResult> {
    let base = index(base);
    let local = index(Some(local));
    let remote = index(remote);
    let mut keys = BTreeSet::new();
    keys.extend(base.keys().cloned());
    keys.extend(local.keys().cloned());
    keys.extend(remote.keys().cloned());

    let mut entities = Vec::new();
    let mut conflicts = Vec::new();
    for item in keys {
        let base_value = base.get(&item);
        let local_value = local.get(&item);
        let remote_value = remote.get(&item);
        let selected = match (base_value, local_value, remote_value) {
            (None, None, None) => Vec::new(),
            (None, Some(local), None) => vec![local.clone()],
            (None, None, Some(remote)) => vec![remote.clone()],
            (None, Some(local), Some(remote)) if local.digest == remote.digest => {
                vec![local.clone()]
            }
            (None, Some(local), Some(remote)) => {
                if local.domain == DOMAIN_APPLICATION
                    && local
                        .payload
                        .as_object()
                        .is_some_and(serde_json::Map::is_empty)
                {
                    let mut empty_base = local.clone();
                    empty_base.payload = serde_json::json!({});
                    if let Some(merged) = merge_application_fields(&empty_base, local, remote) {
                        vec![merged]
                    } else {
                        let (local_candidate, remote_candidate) = choose_conflict(local, remote);
                        conflicts.push(MergeConflict {
                            domain: local.domain.clone(),
                            entity_id: local.entity_id.clone(),
                            label: local.label.clone(),
                            local_digest: local.digest.clone(),
                            remote_digest: remote.digest.clone(),
                            reason: "independent-initial-identities".to_string(),
                        });
                        vec![local_candidate, remote_candidate]
                    }
                } else {
                    let (local_candidate, remote_candidate) = choose_conflict(local, remote);
                    conflicts.push(MergeConflict {
                        domain: local.domain.clone(),
                        entity_id: local.entity_id.clone(),
                        label: local.label.clone(),
                        local_digest: local.digest.clone(),
                        remote_digest: remote.digest.clone(),
                        reason: "independent-initial-identities".to_string(),
                    });
                    vec![local_candidate, remote_candidate]
                }
            }
            (Some(_base), Some(local), Some(remote)) if local.digest == remote.digest => {
                vec![local.clone()]
            }
            (Some(base), Some(local), Some(remote))
                if base.domain == DOMAIN_APPLICATION
                    && local.domain == DOMAIN_APPLICATION
                    && remote.domain == DOMAIN_APPLICATION =>
            {
                if let Some(merged) = merge_application_fields(base, local, remote) {
                    vec![merged]
                } else {
                    let (local_candidate, remote_candidate) = choose_conflict(local, remote);
                    conflicts.push(MergeConflict {
                        domain: base.domain.clone(),
                        entity_id: base.entity_id.clone(),
                        label: base.label.clone(),
                        local_digest: local.digest.clone(),
                        remote_digest: remote.digest.clone(),
                        reason: "same-application-field-changed-on-both-devices".to_string(),
                    });
                    vec![local_candidate, remote_candidate]
                }
            }
            (Some(base), Some(local), remote) if local.digest == base.digest => {
                remote.cloned().into_iter().collect()
            }
            (Some(base), local, Some(remote)) if remote.digest == base.digest => {
                local.cloned().into_iter().collect()
            }
            (Some(base), None, Some(remote)) if remote.digest == base.digest => {
                vec![PortableEntity {
                    domain: base.domain.clone(),
                    entity_id: base.entity_id.clone(),
                    label: base.label.clone(),
                    deleted: true,
                    requires_approval: false,
                    secret_bearing: base.secret_bearing,
                    mapping_required: base.mapping_required,
                    digest: base.digest.clone(),
                    payload: base.payload.clone(),
                    resource_ids: Vec::new(),
                }]
            }
            (Some(base), Some(local), None) if local.digest == base.digest => {
                vec![PortableEntity {
                    domain: base.domain.clone(),
                    entity_id: base.entity_id.clone(),
                    label: base.label.clone(),
                    deleted: true,
                    requires_approval: false,
                    secret_bearing: base.secret_bearing,
                    mapping_required: base.mapping_required,
                    digest: base.digest.clone(),
                    payload: base.payload.clone(),
                    resource_ids: Vec::new(),
                }]
            }
            (Some(base), None, None) => vec![PortableEntity {
                domain: base.domain.clone(),
                entity_id: base.entity_id.clone(),
                label: base.label.clone(),
                deleted: true,
                requires_approval: false,
                secret_bearing: base.secret_bearing,
                mapping_required: base.mapping_required,
                digest: base.digest.clone(),
                payload: base.payload.clone(),
                resource_ids: Vec::new(),
            }],
            (Some(base), local, remote) => {
                let local = local.ok_or_else(|| anyhow::anyhow!("local merge state missing"))?;
                let remote = remote.ok_or_else(|| anyhow::anyhow!("remote merge state missing"))?;
                let (local_candidate, remote_candidate) = choose_conflict(local, remote);
                conflicts.push(MergeConflict {
                    domain: base.domain.clone(),
                    entity_id: base.entity_id.clone(),
                    label: base.label.clone(),
                    local_digest: local.digest.clone(),
                    remote_digest: remote.digest.clone(),
                    reason: if local.deleted || remote.deleted {
                        "delete-versus-edit".to_string()
                    } else {
                        "same-merge-unit-changed-on-both-devices".to_string()
                    },
                });
                vec![local_candidate, remote_candidate]
            }
        };
        entities.extend(selected);
    }

    entities.sort_by(|left, right| {
        left.domain
            .cmp(&right.domain)
            .then(left.entity_id.cmp(&right.entity_id))
    });
    if entities.len() > 4096 {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: revision contains too many entities");
    }
    Ok(MergeResult {
        entities,
        conflicts,
    })
}

pub fn snapshot_with_tombstones(
    base: Option<&RevisionManifest>,
    snapshot: &mut LocalSnapshot,
    selection: &CategorySelection,
) {
    let Some(base) = base else {
        return;
    };
    let selected: BTreeSet<(String, String)> = snapshot.manifest.entities.iter().map(key).collect();
    for entity in &base.entities {
        if selected.contains(&key(entity)) {
            continue;
        }
        if entity.deleted {
            // Tombstones are part of the merge input even when the local
            // filesystem no longer has a live entity. Keeping them in the
            // acknowledged baseline prevents a deleted item from being
            // republished forever and lets an opted-out category rejoin with
            // an explicit delete-versus-edit review.
            snapshot.manifest.entities.push(entity.clone());
            continue;
        }
        if selection.is_selected(&entity.domain) {
            snapshot.manifest.entities.push(PortableEntity {
                domain: entity.domain.clone(),
                entity_id: entity.entity_id.clone(),
                label: entity.label.clone(),
                deleted: true,
                requires_approval: entity.requires_approval,
                secret_bearing: entity.secret_bearing,
                mapping_required: entity.mapping_required,
                digest: entity.digest.clone(),
                payload: entity.payload.clone(),
                resource_ids: Vec::new(),
            });
        } else {
            // Category opt-out is a subscription policy, not a delete. Keep
            // the last acknowledged value in the local merge input so remote
            // changes can be carried forward without being applied locally.
            snapshot.manifest.entities.push(entity.clone());
        }
    }
    snapshot.manifest.entities.sort_by(|left, right| {
        left.domain
            .cmp(&right.domain)
            .then(left.entity_id.cmp(&right.entity_id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(id: &str, value: &str) -> PortableEntity {
        PortableEntity {
            domain: "test".into(),
            entity_id: id.into(),
            label: id.into(),
            deleted: false,
            requires_approval: false,
            secret_bearing: false,
            mapping_required: false,
            digest: value.into(),
            payload: serde_json::json!({ "value": value }),
            resource_ids: vec![],
        }
    }

    fn manifest(values: Vec<PortableEntity>) -> RevisionManifest {
        RevisionManifest {
            format: "test".into(),
            version: 1,
            revision_id: "r".into(),
            parents: vec![],
            created_at: "2026-01-01T00:00:00Z".into(),
            entities: values,
            resource_ids: vec![],
        }
    }

    #[test]
    fn disjoint_edits_merge_and_repeat_is_idempotent() {
        let base = manifest(vec![entity("a", "0"), entity("b", "0")]);
        let local = manifest(vec![entity("a", "1"), entity("b", "0")]);
        let remote = manifest(vec![entity("a", "0"), entity("b", "2")]);
        let merged = three_way(Some(&base), &local, Some(&remote)).expect("merge");
        assert!(merged.conflicts.is_empty());
        assert_eq!(merged.entities[0].digest, "1");
        assert_eq!(merged.entities[1].digest, "2");
        let next = manifest(merged.entities.clone());
        let repeated = three_way(Some(&next), &next, Some(&next)).expect("repeat");
        assert_eq!(repeated.entities, next.entities);
        assert!(repeated.conflicts.is_empty());
    }

    #[test]
    fn same_unit_edit_retains_both_candidates() {
        let base = manifest(vec![entity("a", "0")]);
        let local = manifest(vec![entity("a", "1")]);
        let remote = manifest(vec![entity("a", "2")]);
        let merged = three_way(Some(&base), &local, Some(&remote)).expect("merge");
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(merged.entities.len(), 2);
        assert!(merged
            .entities
            .iter()
            .any(|item| item.entity_id.ends_with(":local")));
        assert!(merged
            .entities
            .iter()
            .any(|item| item.entity_id.ends_with(":remote")));
    }

    #[test]
    fn category_opt_out_keeps_the_base_value_in_the_merge_input() {
        let base = manifest(vec![entity("a", "0")]);
        let mut local = LocalSnapshot {
            manifest: manifest(vec![]),
            resources: BTreeMap::new(),
        };
        let mut selection = CategorySelection::default();
        selection.0.insert("test".into(), false);
        snapshot_with_tombstones(Some(&base), &mut local, &selection);
        assert_eq!(local.manifest.entities, base.entities);

        let remote = manifest(vec![entity("a", "1")]);
        let merged = three_way(Some(&base), &local.manifest, Some(&remote)).expect("merge");
        assert_eq!(merged.entities, remote.entities);
        assert!(merged.conflicts.is_empty());
    }

    #[test]
    fn explicit_tombstone_deletion_converges_without_becoming_an_implicit_delete() {
        let base = manifest(vec![entity("a", "0")]);
        let mut deleted = entity("a", "0");
        deleted.deleted = true;
        let local = manifest(vec![deleted]);
        let remote = manifest(vec![entity("a", "0")]);
        let merged = three_way(Some(&base), &local, Some(&remote)).expect("merge");
        assert_eq!(merged.entities.len(), 1);
        assert!(merged.entities[0].deleted);

        let next = manifest(merged.entities.clone());
        let repeated = three_way(Some(&next), &next, Some(&next)).expect("repeat");
        assert_eq!(repeated.entities, next.entities);
        assert!(repeated.conflicts.is_empty());
    }

    #[test]
    fn acknowledged_tombstones_stay_in_the_next_local_merge_input() {
        let mut tombstone = entity("a", "0");
        tombstone.deleted = true;
        let base = manifest(vec![tombstone.clone()]);
        let mut local = LocalSnapshot {
            manifest: manifest(vec![]),
            resources: BTreeMap::new(),
        };
        snapshot_with_tombstones(Some(&base), &mut local, &CategorySelection::all_selected());
        assert_eq!(local.manifest.entities, vec![tombstone]);
    }

    #[test]
    fn application_preferences_merge_disjoint_fields_but_conflict_on_one_field() {
        let mut base = entity("application", "base");
        base.domain = DOMAIN_APPLICATION.into();
        base.payload = serde_json::json!({"theme": "dark", "language": "en"});
        refresh_digest(&mut base);
        let mut local = base.clone();
        local.payload["theme"] = serde_json::json!("light");
        refresh_digest(&mut local);
        let mut remote = base.clone();
        remote.payload["language"] = serde_json::json!("zh-CN");
        refresh_digest(&mut remote);

        let merged = three_way(
            Some(&manifest(vec![base.clone()])),
            &manifest(vec![local.clone()]),
            Some(&manifest(vec![remote.clone()])),
        )
        .expect("merge disjoint settings");
        assert!(merged.conflicts.is_empty());
        assert_eq!(merged.entities[0].payload["theme"], "light");
        assert_eq!(merged.entities[0].payload["language"], "zh-CN");

        let mut deleted_local = base.clone();
        deleted_local
            .payload
            .as_object_mut()
            .unwrap()
            .remove("theme");
        refresh_digest(&mut deleted_local);
        let deletion = three_way(
            Some(&manifest(vec![base.clone()])),
            &manifest(vec![deleted_local]),
            Some(&manifest(vec![base.clone()])),
        )
        .expect("merge deleted setting");
        assert!(!deletion.entities[0]
            .payload
            .as_object()
            .unwrap()
            .contains_key("theme"));

        let mut conflicting_remote = base.clone();
        conflicting_remote.payload["theme"] = serde_json::json!("system");
        refresh_digest(&mut conflicting_remote);
        let conflicting = three_way(
            Some(&manifest(vec![base])),
            &manifest(vec![local]),
            Some(&manifest(vec![conflicting_remote])),
        )
        .expect("merge conflicting settings");
        assert_eq!(conflicting.conflicts.len(), 1);
        assert_eq!(conflicting.entities.len(), 2);
    }

    #[test]
    fn empty_initial_application_state_adopts_remote_fields_without_conflict() {
        let mut local = entity("application", "empty");
        local.domain = DOMAIN_APPLICATION.into();
        local.payload = serde_json::json!({});
        refresh_digest(&mut local);
        let mut remote = entity("application", "remote");
        remote.domain = DOMAIN_APPLICATION.into();
        remote.payload = serde_json::json!({
            "theme": "dark",
            "language": "zh-CN"
        });
        refresh_digest(&mut remote);

        let merged = three_way(None, &manifest(vec![local]), Some(&manifest(vec![remote])))
            .expect("merge initial application state");
        assert!(merged.conflicts.is_empty());
        assert_eq!(merged.entities.len(), 1);
        assert_eq!(merged.entities[0].payload["theme"], "dark");
        assert_eq!(merged.entities[0].payload["language"], "zh-CN");
    }
}
