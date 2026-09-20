use super::*;

const ORDER_SETTING: &str = "providers.order";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReorderInput {
    pub id: String,
    pub target_id: String,
    pub placement: Placement,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Before,
    After,
}

pub(super) fn apply_saved_order(db: &Database, providers: &mut [ProviderPublic]) -> Result<()> {
    let Some(value) = db.get_setting(ORDER_SETTING)? else {
        return Ok(());
    };
    let ids: Vec<String> = serde_json::from_value(value)?;
    let ranks: BTreeMap<_, _> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    // Stable sorting retains creation order for providers added after the last move.
    providers.sort_by_key(|provider| {
        ranks
            .get(provider.id.as_str())
            .copied()
            .unwrap_or(usize::MAX)
    });
    Ok(())
}

/// Move against the current host list so concurrent additions cannot disappear.
/// A missing source or target returns false without changing the saved order.
pub fn reorder_providers(
    db: &Database,
    secrets: &SecretStore,
    input: ProviderReorderInput,
) -> Result<bool> {
    let providers = list_providers(db, secrets, true)?;
    let mut ids: Vec<String> = providers.into_iter().map(|provider| provider.id).collect();
    let Some(source) = ids.iter().position(|id| id == &input.id) else {
        return Ok(false);
    };
    let Some(target) = ids.iter().position(|id| id == &input.target_id) else {
        return Ok(false);
    };
    if source == target {
        return Ok(true);
    }
    let destination = target + usize::from(matches!(input.placement, Placement::After))
        - usize::from(source < target);
    if source == destination {
        return Ok(true);
    }
    let id = ids.remove(source);
    ids.insert(destination, id);
    db.set_setting(ORDER_SETTING, &serde_json::to_value(ids)?)?;
    Ok(true)
}
