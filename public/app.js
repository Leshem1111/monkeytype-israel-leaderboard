(async function () {
  const tbody = document.getElementById("lb-body");
  const refreshBtn = document.getElementById("refreshBtn");

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString();
    } catch {
      return "—";
    }
  }

  function render(rows) {
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No entries yet — click “Login to Monkeytype” to join.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((u, i) => {
        const wpm = (u.wpm15 ?? 0).toString();
        const acc = (u.accuracy ?? 0).toFixed(2) + "%";
        const ts = fmtTime(u.timestamp);
        return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(u.username)}</td>
            <td>${wpm}</td>
            <td>${acc}</td>
            <td class="muted">${ts}</td>
          </tr>
        `;
      })
      .join("");
  }

  async function load() {
    try {
      const r = await fetch("/api/leaderboard", { headers: { "Cache-Control": "no-cache" } });
      const j = await r.json();
      render(j.users || []);
      // Show/hide demo hint if server included mode
      const demo = document.getElementById("demoHint");
      if (j.mode === "demo") demo.hidden = false; else demo.hidden = true;
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load leaderboard.</td></tr>`;
      console.error(e);
    }
  }

  refreshBtn?.addEventListener("click", load);

  // basic HTML escaping for usernames
  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  await load();
})();
