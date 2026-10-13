use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;

const MCP_URL: &str = "http://127.0.0.1:3003/mcp";
const MAX_RESPONSE_BYTES: usize = 100_000;
/// Matches the 4,000-character limit enforced in JavaScript, which counts UTF-16 units.
const MAX_QUERY_UNITS: usize = 4000;

fn parse_rpc(body: &str, id: u64) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if value["id"] == id && value.get("result").is_some() {
            return Ok(value["result"].clone());
        }
    }
    for line in body.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                if value["id"] == id && value.get("result").is_some() {
                    return Ok(value["result"].clone());
                }
            }
        }
    }
    Err("Invalid Firecrawl MCP response".into())
}

async fn request(
    client: &Client,
    message: Value,
    session: &mut Option<String>,
) -> Result<String, String> {
    let mut request = client
        .post(MCP_URL)
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .json(&message);
    if let Some(id) = session.as_ref() {
        request = request.header("mcp-session-id", id);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Start the Firecrawl MCP container and try again".to_string())?;
    if !response.status().is_success() {
        return Err("Firecrawl MCP request failed".into());
    }
    if let Some(id) = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
    {
        *session = Some(id.to_string());
    }
    // Enforce the size limit while streaming, so an oversized body is never fully buffered.
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read MCP response".to_string())?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Search response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "Invalid MCP response".to_string())
}

#[tauri::command]
pub async fn firecrawl_search(query: String) -> Result<Value, String> {
    if query.trim().is_empty() || query.encode_utf16().count() > MAX_QUERY_UNITS {
        return Err("Invalid search query".into());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|_| "Could not start MCP client".to_string())?;
    let mut session = None;
    let init = request(
        &client,
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "colony-desktop", "version": "0.1.0" } }
        }),
        &mut session,
    )
    .await?;
    parse_rpc(&init, 1)?;
    request(
        &client,
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        &mut session,
    )
    .await?;
    let body = request(
        &client,
        json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "firecrawl_search", "arguments": { "query": query, "limit": 5 } }
        }),
        &mut session,
    )
    .await?;
    parse_rpc(&body, 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_json_and_sse_without_accepting_another_request() {
        assert_eq!(
            parse_rpc(r#"{"jsonrpc":"2.0","id":2,"result":{"ok":true}}"#, 2).unwrap()["ok"],
            true
        );
        assert_eq!(
            parse_rpc(
                "event: message\ndata: {\"id\":2,\"result\":{\"ok\":true}}\n\n",
                2
            )
            .unwrap()["ok"],
            true
        );
        assert!(parse_rpc(r#"{"id":1,"result":{}}"#, 2).is_err());
    }

    #[test]
    #[ignore = "Requires the local Firecrawl and MCP Docker containers"]
    fn live_self_hosted_search() {
        let result =
            tauri::async_runtime::block_on(firecrawl_search("Tauri 2 documentation".into()))
                .unwrap();
        assert_ne!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        let sources: Value = serde_json::from_str(text).unwrap();
        assert!(
            sources["web"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["url"].as_str().unwrap_or("").contains("tauri.app"))
        );
    }
}
