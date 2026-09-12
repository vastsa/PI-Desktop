use super::*;

impl PluginManager {
    pub fn install_from_path(
        &mut self,
        source_path: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        let source = PathBuf::from(source_path);
        if !source.exists() {
            bail!("PLUGIN_INVALID: package path missing");
        }

        let stage = self
            .data_dir
            .join("plugins/cache/download")
            .join(format!("stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&stage)?;
        let cleanup_stage = stage.clone();
        let result = (|| -> Result<InstallResult> {
            let extracted_root = if source.is_dir() {
                copy_dir_filtered(&source, &stage.join("content"))?;
                stage.join("content")
            } else {
                let bytes = fs::read(&source)
                    .with_context(|| format!("read package {}", source.display()))?;
                if bytes.len() as u64 > MAX_PACKAGE_BYTES {
                    bail!("PLUGIN_INVALID: package exceeds 50MB limit");
                }
                if let Some(expected) = &opts.expected_shasum {
                    let actual = sha256_hex(&bytes);
                    if !actual.eq_ignore_ascii_case(expected) {
                        bail!("PLUGIN_INTEGRITY: checksum mismatch");
                    }
                }
                let extract_dir = stage.join("extract");
                fs::create_dir_all(&extract_dir)?;
                extract_zip_bytes(&bytes, &extract_dir)?;
                find_plugin_root(&extract_dir)?
            };

            let manifest = Self::read_manifest(&extracted_root)?;
            let existing = self.get(&manifest.id);
            let upgraded = existing
                .as_ref()
                .map(|p| p.version != manifest.version)
                .unwrap_or(false);
            let permission_diff = permission_diff(
                existing
                    .as_ref()
                    .map(|p| p.permissions.as_slice())
                    .unwrap_or(&[]),
                &manifest.permissions,
            );

            if upgraded {
                if let Some(prev) = &existing {
                    if let Some(prev_path) = prev.path.as_ref() {
                        let backup = self
                            .data_dir
                            .join("plugins/cache/backup")
                            .join(sanitize_id(&prev.id))
                            .join(&prev.version);
                        let _ = fs::remove_dir_all(&backup);
                        if PathBuf::from(prev_path).exists() {
                            copy_dir_filtered(Path::new(prev_path), &backup)?;
                        }
                    }
                }
            }

            let target = self.installed_dir(&manifest.id);
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_dir_filtered(&extracted_root, &target)?;
            fs::create_dir_all(self.data_dir_for(&manifest.id))?;

            let now = Utc::now().to_rfc3339();
            let granted = opts
                .granted_permissions
                .clone()
                .unwrap_or_else(|| manifest.permissions.clone());
            for required in &manifest.permissions {
                if !granted.iter().any(|g| g == required) {
                    bail!("PLUGIN_PERMISSION_DENIED: missing grant for {required}");
                }
            }

            let summary = PluginSummary {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                version: manifest.version.clone(),
                enabled: opts.enable,
                // An update must not silently widen a project-scoped plugin
                // back to every project.
                scope: existing
                    .as_ref()
                    .map(|p| p.scope.clone())
                    .unwrap_or_default(),
                source: opts.source.clone(),
                status: if opts.enable {
                    "ready".into()
                } else {
                    "disabled".into()
                },
                error_message: None,
                permissions: granted,
                path: Some(target.to_string_lossy().to_string()),
                capabilities: derive_capabilities(&manifest),
                description: manifest.description.clone(),
                author: manifest.author.clone(),
                installed_at: existing
                    .as_ref()
                    .and_then(|p| p.installed_at.clone())
                    .or_else(|| Some(now.clone())),
                updated_at: Some(now),
                marketplace: opts
                    .marketplace
                    .clone()
                    .or_else(|| existing.as_ref().and_then(|p| p.marketplace.clone())),
                auto_update: Some(
                    opts.auto_update
                        || existing
                            .as_ref()
                            .and_then(|p| p.auto_update)
                            .unwrap_or(false),
                ),
                update_available: None,
                yanked: None,
                ui: manifest.ui.clone(),
                fs: manifest.fs.clone(),
                settings: derive_settings(&manifest),
            };
            let plugin = self.upsert_summary(summary)?;
            Ok(InstallResult {
                plugin,
                upgraded,
                permission_diff,
            })
        })();

        let _ = fs::remove_dir_all(cleanup_stage);
        result
    }

    pub fn install_from_package(
        &mut self,
        package_path: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        self.install_from_path(package_path, opts)
    }

    pub fn install_from_market(
        &mut self,
        plugin_id: &str,
        version: Option<&str>,
        enable: bool,
        auto_update: bool,
        granted_permissions: Option<Vec<String>>,
    ) -> Result<InstallResult> {
        let info = self.market_download_info(plugin_id, version)?;
        let package_path = self.download_market_package(&info)?;
        let marketplace = PluginMarketplaceMeta {
            provider_id: "official".into(),
            shasum: Some(info.shasum.clone()),
            // Record the publisher the catalog named. Falling back to the
            // project keeps registries written before publisher-owned sources
            // readable, but a v2 entry must not be relabelled as ours.
            publisher_id: Some(
                info.publisher_id
                    .clone()
                    .unwrap_or_else(|| "pi-desktop".into()),
            ),
            trust: info.trust.clone(),
            provenance: info.provenance.clone(),
        };
        let result = self.install_from_path(
            &package_path.to_string_lossy(),
            InstallOptions {
                source: "marketplace".into(),
                enable,
                marketplace: Some(marketplace),
                expected_shasum: Some(info.shasum),
                auto_update,
                granted_permissions,
            },
        );
        let _ = fs::remove_file(package_path);
        result
    }

    pub fn apply_updates(&mut self, only_auto: bool) -> Result<Vec<InstallResult>> {
        let _ = self.check_updates(true)?;
        let pending: Vec<(String, PluginUpdateInfo, bool, Vec<String>)> = self
            .runtime
            .iter()
            .filter_map(|p| {
                let update = p.update_available.clone()?;
                // An announced-but-unpublished version stays visible as an
                // update, yet installing it can only fail. Skipping it here
                // keeps one incomplete catalog entry from aborting the batch.
                if update.shasum.trim().is_empty() || update.url.trim().is_empty() {
                    return None;
                }
                if only_auto && !p.auto_update.unwrap_or(false) {
                    return None;
                }
                // Auto-update refuses silent permission expansion.
                if only_auto && !update.permission_diff.is_empty() {
                    return None;
                }
                Some((
                    p.id.clone(),
                    update,
                    p.auto_update.unwrap_or(false),
                    p.permissions.clone(),
                ))
            })
            .collect();

        let mut results = Vec::new();
        for (id, update, auto_update, current_permissions) in pending {
            let mut granted = current_permissions;
            for perm in &update.permission_diff {
                if !granted.iter().any(|p| p == perm) {
                    granted.push(perm.clone());
                }
            }
            let installed = self.install_from_market(
                &id,
                Some(&update.version),
                true,
                auto_update,
                Some(granted),
            )?;
            results.push(installed);
        }
        Ok(results)
    }

    fn download_market_package(&self, info: &MarketDownloadInfo) -> Result<PathBuf> {
        let cache = self.data_dir.join("plugins/cache/download").join(format!(
            "{}-{}.piplug",
            sanitize_id(&info.plugin_id),
            sanitize_id(&info.version)
        ));
        if let Some(parent) = cache.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = if let Some(path) = info.url.strip_prefix("file://") {
            fs::read(path).with_context(|| format!("read market package {path}"))?
        } else if info.url.starts_with("http://") || info.url.starts_with("https://") {
            // Refuse an off-allowlist host before any request leaves the
            // machine, then hold the redirect chain to the same rule.
            let catalog_url = self.market_source_url();
            package_host_allowed(&info.url, &catalog_url)?;
            download_url_guarded(&info.url, Some(&catalog_url))?
        } else {
            // Allow bare local paths in catalogs.
            fs::read(&info.url).with_context(|| format!("read market package {}", info.url))?
        };
        if bytes.len() as u64 > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(&info.shasum) {
            bail!("PLUGIN_INTEGRITY: checksum mismatch");
        }
        fs::write(&cache, &bytes)?;
        Ok(cache)
    }
}

pub(crate) fn extract_zip_bytes(bytes: &[u8], dest: &Path) -> Result<()> {
    if bytes.len() < 22 {
        bail!("PLUGIN_INVALID: zip too small");
    }
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    let mut offset = 0usize;
    while offset + 30 <= bytes.len() {
        let sig = read_u32(bytes, offset)?;
        if sig == 0x02014b50 || sig == 0x06054b50 {
            break;
        }
        if sig != 0x04034b50 {
            bail!("PLUGIN_INVALID: bad zip local header");
        }
        let method = read_u16(bytes, offset + 8)?;
        let comp_size = read_u32(bytes, offset + 18)? as usize;
        let uncomp_size = read_u32(bytes, offset + 22)? as u64;
        let name_len = read_u16(bytes, offset + 26)? as usize;
        let extra_len = read_u16(bytes, offset + 28)? as usize;
        let name_start = offset + 30;
        let name_end = name_start + name_len;
        if name_end + extra_len + comp_size > bytes.len() {
            bail!("PLUGIN_INVALID: zip entry truncated");
        }
        let name = std::str::from_utf8(&bytes[name_start..name_end])
            .map_err(|_| anyhow!("PLUGIN_INVALID: zip name not utf8"))?;
        if method != 0 {
            bail!("PLUGIN_INVALID: only store-compressed piplug supported");
        }
        let data_start = name_end + extra_len;
        let data_end = data_start + comp_size;
        let data = &bytes[data_start..data_end];
        total_bytes += uncomp_size;
        if total_bytes > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        file_count += 1;
        if file_count > MAX_PACKAGE_FILES {
            bail!("PLUGIN_INVALID: too many files in package");
        }
        if name.ends_with('/') {
            let dir = safe_join(dest, name)?;
            fs::create_dir_all(dir)?;
        } else {
            let path = safe_join(dest, name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, data)?;
        }
        offset = data_end;
    }
    Ok(())
}

pub(crate) fn find_plugin_root(extract_dir: &Path) -> Result<PathBuf> {
    let direct = extract_dir.join("manifest.json");
    if direct.exists() {
        return Ok(extract_dir.to_path_buf());
    }
    for entry in fs::read_dir(extract_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let candidate = entry.path();
            if candidate.join("manifest.json").exists() {
                return Ok(candidate);
            }
        }
    }
    bail!("PLUGIN_INVALID: manifest.json missing in package")
}

pub(crate) fn copy_dir_filtered(src: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    fn walk(from: &Path, to: &Path, file_count: &mut usize, total_bytes: &mut u64) -> Result<()> {
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".git" || name_str == "node_modules" {
                continue;
            }
            let target = to.join(&name);
            if file_type.is_symlink() {
                bail!("PLUGIN_INVALID: symlinks are not allowed");
            } else if file_type.is_dir() {
                fs::create_dir_all(&target)?;
                walk(&entry.path(), &target, file_count, total_bytes)?;
            } else if file_type.is_file() {
                *file_count += 1;
                if *file_count > MAX_PACKAGE_FILES {
                    bail!("PLUGIN_INVALID: too many files in package");
                }
                let meta = entry.metadata()?;
                *total_bytes += meta.len();
                if *total_bytes > MAX_PACKAGE_BYTES {
                    bail!("PLUGIN_INVALID: package exceeds 50MB limit");
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }
    walk(src, dest, &mut file_count, &mut total_bytes)
}

pub(crate) fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') {
        bail!("PLUGIN_INVALID: absolute paths are not allowed");
    }
    let mut out = base.to_path_buf();
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => bail!("PLUGIN_INVALID: path traversal is not allowed"),
            _ => bail!("PLUGIN_INVALID: unsupported path component"),
        }
    }
    if !out.starts_with(base) {
        bail!("PLUGIN_INVALID: path escaped package root");
    }
    Ok(out)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for b in data {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            let mask = (!(crc & 1)).wrapping_add(1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

pub(crate) fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: zip truncated"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: zip truncated"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

pub(crate) fn download_url(url: &str) -> Result<Vec<u8>> {
    download_url_guarded(url, None)
}

/// Decode text emitted by the external curl process.
///
/// curl writes UTF-8 on some installations but uses the active Windows ANSI
/// code page for localized Schannel diagnostics on others. The RPC boundary is
/// UTF-8, so treating every stderr buffer as UTF-8 turns a useful localized
/// error into replacement characters. Prefer UTF-8 and only use the Windows
/// code page fallback when the bytes prove not to be UTF-8.
pub(crate) fn decode_curl_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }

    #[cfg(windows)]
    if let Some(text) = decode_windows_code_page(bytes, windows_sys::Win32::Globalization::CP_ACP) {
        return text;
    }

    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
fn decode_windows_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    let byte_len = i32::try_from(bytes.len()).ok()?;
    if byte_len == 0 {
        return Some(String::new());
    }

    let wide_len =
        unsafe { MultiByteToWideChar(code_page, 0, bytes.as_ptr(), byte_len, null_mut(), 0) };
    if wide_len <= 0 {
        return None;
    }

    let mut wide = vec![0u16; wide_len as usize];
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            byte_len,
            wide.as_mut_ptr(),
            wide_len,
        )
    };
    if written <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&wide[..written as usize]))
}

/// Unique scratch path for one guarded download.
///
/// curl writes the body to a file so stdout can carry only the effective URL;
/// mixing them would corrupt a binary package.
fn download_scratch_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "pi-desktop-download-{}-{seq}-{nanos}.bin",
        std::process::id()
    ))
}

/// Fetch a URL, optionally holding every redirect hop inside the package host
/// allowlist.
///
/// `package_guard` carries the catalog URL in effect when the download is a
/// marketplace package. A GitHub release asset always redirects to a storage
/// host, so the initial URL passing the allowlist is not sufficient on its
/// own: redirects are restricted to HTTPS and the effective URL is re-checked
/// under the same rule before the bytes are accepted.
pub(crate) fn download_url_guarded(url: &str, package_guard: Option<&str>) -> Result<Vec<u8>> {
    if let Some(path) = url.strip_prefix("file://") {
        return fs::read(path).with_context(|| format!("read local url {path}"));
    }

    // Prefer curl for robust HTTPS support on developer and CI machines.
    let scratch = package_guard.map(|_| download_scratch_path());
    let max_filesize = MAX_PACKAGE_BYTES.to_string();
    let mut args: Vec<String> = vec![
        "--silent".into(),
        "--show-error".into(),
        "--location".into(),
        "--fail".into(),
        "--max-time".into(),
        "30".into(),
        "--max-redirs".into(),
        "5".into(),
        "--max-filesize".into(),
        max_filesize,
        "--user-agent".into(),
        "pi-desktop-host-core".into(),
    ];
    args.extend(crate::network_proxy::curl_proxy_args());
    if package_guard.is_some() && url.starts_with("https://") {
        // Downgrading to plain HTTP mid-redirect would take the request off
        // the host the allowlist approved.
        args.push("--proto".into());
        args.push("=https".into());
        args.push("--proto-redir".into());
        args.push("=https".into());
    }
    if let Some(scratch) = scratch.as_ref() {
        args.push("--output".into());
        args.push(scratch.to_string_lossy().into_owned());
        args.push("--write-out".into());
        args.push("%{url_effective}".into());
    }
    args.push(url.to_string());

    let outcome = std::process::Command::new("curl").args(&args).output();
    if let Ok(output) = outcome {
        if output.status.success() {
            let body = match scratch.as_ref() {
                Some(scratch) => {
                    let effective = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let guard_result = match package_guard {
                        Some(catalog_url) if !effective.is_empty() => {
                            package_host_allowed(&effective, catalog_url)
                        }
                        _ => Ok(()),
                    };
                    let body = guard_result.and_then(|()| {
                        fs::read(scratch).with_context(|| format!("read download {url}"))
                    });
                    let _ = fs::remove_file(scratch);
                    body?
                }
                None => output.stdout,
            };
            if body.len() as u64 > MAX_PACKAGE_BYTES {
                bail!("PLUGIN_INVALID: package exceeds 50MB limit");
            }
            return Ok(body);
        }
        if let Some(scratch) = scratch.as_ref() {
            let _ = fs::remove_file(scratch);
        }
        let err = decode_curl_output(&output.stderr);
        // Fall through to raw HTTP only for http:// URLs.
        if url.starts_with("https://") {
            bail!("PLUGIN_NETWORK: curl failed for {url}: {err}");
        }
    } else if url.starts_with("https://") {
        bail!("PLUGIN_NETWORK: curl is required to fetch https marketplace urls");
    }

    if let Some(rest) = url.strip_prefix("http://") {
        let (host_port, path) = rest.split_once('/').unwrap_or((rest, ""));
        let path = if path.is_empty() {
            "/".to_string()
        } else {
            format!("/{path}")
        };
        let host = host_port.split(':').next().unwrap_or(host_port);
        let port: u16 = host_port
            .split(':')
            .nth(1)
            .and_then(|p| p.parse().ok())
            .unwrap_or(80);
        let mut stream = std::net::TcpStream::connect((host, port))
            .with_context(|| format!("connect {host}:{port}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(15)))?;
        stream.set_write_timeout(Some(Duration::from_secs(15)))?;
        let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: pi-desktop-host-core\r\nAccept: */*\r\n\r\n"
    );
        stream.write_all(req.as_bytes())?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf)?;
        let text = String::from_utf8_lossy(&buf);
        let Some(idx) = text.find("\r\n\r\n") else {
            bail!("PLUGIN_NETWORK: invalid HTTP response");
        };
        let body = buf[idx + 4..].to_vec();
        if body.len() as u64 > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        return Ok(body);
    }

    bail!("PLUGIN_NETWORK: unsupported marketplace url: {url}")
}
