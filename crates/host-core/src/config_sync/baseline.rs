//! A cloud acknowledgement and its local projection are one atomic record.
//! Credential opt-outs and device overlays must not manufacture local edits.
use super::*;

#[derive(Serialize, Deserialize)]
pub(super) struct Baseline {
    pub shared: RevisionManifest,
    pub observed: RevisionManifest,
}

pub(super) fn load(st: &AppState, key: &VaultKey) -> Result<Option<Baseline>> {
    let baseline: Option<Baseline> =
        load_encrypted(st, key, "local-base", &local_path(st, "base.bin")?)?;
    Ok(baseline.map(|mut baseline| {
        domains::retain_supported_entities(&mut baseline.shared);
        domains::retain_supported_entities(&mut baseline.observed);
        baseline
    }))
}

pub(super) fn store(
    st: &AppState,
    key: &VaultKey,
    shared: &RevisionManifest,
    observed: &RevisionManifest,
) -> Result<()> {
    persist_encrypted(
        st,
        key,
        "local-base",
        &local_path(st, "base.bin")?,
        &Baseline {
            shared: shared.clone(),
            observed: observed.clone(),
        },
    )
}

pub(super) fn merge_input(
    local: &mut RevisionManifest,
    baseline: &Baseline,
    include_secrets: bool,
) {
    let observed = logical_manifest_map(Some(&baseline.observed));
    let shared = logical_manifest_map(Some(&baseline.shared));
    for entity in &mut local.entities {
        let id = logical_entity_key(entity);
        let (Some(before), Some(acknowledged)) = (observed.get(&id), shared.get(&id)) else {
            continue;
        };
        if merge::same_version(entity, before) {
            *entity = acknowledged.clone();
        } else if !include_secrets && !entity.deleted && !acknowledged.deleted {
            // A metadata edit by an unsubscribed device must not remove cloud
            // credentials it never imported. Only the cloud baseline supplies
            // these fields; no device-local secret is exported here.
            let fields: &[&str] = match entity.domain.as_str() {
                domains::DOMAIN_PROVIDERS => &["portableApiKey"],
                domains::DOMAIN_MCP => &["env", "headers", "envKeys", "headerKeys"],
                _ => &[],
            };
            if !fields.is_empty() {
                if let (Some(payload), Some(source)) = (
                    entity.payload.as_object_mut(),
                    acknowledged.payload.as_object(),
                ) {
                    for field in fields {
                        payload.remove(*field);
                        if let Some(value) = source.get(*field) {
                            payload.insert((*field).into(), value.clone());
                        }
                    }
                    entity.secret_bearing = acknowledged.secret_bearing;
                    entity.requires_approval |= acknowledged.requires_approval;
                    domains::refresh_digest(entity);
                }
            }
        }
    }
}

pub(super) fn advance_observed(
    previous: Option<&RevisionManifest>,
    current: &RevisionManifest,
    applied: &BTreeSet<(String, String)>,
) -> RevisionManifest {
    let mut observed = logical_manifest_map(previous);
    let current_values = logical_manifest_map(Some(current));
    for id in applied {
        if let Some(entity) = current_values.get(id) {
            observed.insert(id.clone(), entity.clone());
        } else {
            observed.remove(id);
        }
    }
    RevisionManifest {
        entities: observed.into_values().collect(),
        ..current.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unacknowledged_local_edits_are_not_hidden_by_the_baseline() {
        let entity = PortableEntity {
            domain: domains::DOMAIN_APPLICATION.into(),
            entity_id: "application".into(),
            label: "Preferences".into(),
            deleted: false,
            requires_approval: false,
            secret_bearing: false,
            mapping_required: false,
            digest: "old".into(),
            payload: json!({"theme":"light"}),
            resource_ids: vec![],
        };
        let before = RevisionManifest {
            format: REVISION_FORMAT.into(),
            version: 1,
            revision_id: "before".into(),
            created_at: String::new(),
            parents: vec![],
            entities: vec![entity.clone()],
            resource_ids: vec![],
        };
        let mut current = before.clone();
        current.entities[0].payload = json!({"theme":"dark"});
        domains::refresh_digest(&mut current.entities[0]);
        let observed = advance_observed(Some(&before), &current, &BTreeSet::new());
        assert_eq!(observed.entities, before.entities);
        let baseline = Baseline {
            shared: before,
            observed,
        };
        let mut candidate = current.clone();
        merge_input(&mut candidate, &baseline, false);
        assert_eq!(candidate.entities, current.entities);
        let applied = BTreeSet::from([entity_key(&entity)]);
        assert_eq!(
            advance_observed(Some(&baseline.observed), &current, &applied).entities,
            current.entities
        );
    }
}
