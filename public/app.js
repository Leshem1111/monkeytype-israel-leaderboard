(async function () {
  const tbody = document.getElementById("lb-body");
  const refreshBtn = document.getElementById("refreshBtn");
  const loginBtn = document.getElementById("loginBtn");
  const logoutForm = document.getElementById("logoutForm");

  // --- session -> toggle login button text ---
  async function updateLoginButton() {
    try {
      const r = await fetch("/api/session", { credentials: "same-origin" });
      const j = await r.json();

      if (j.loggedIn) {
        if (loginBtn) {
          loginBtn.textContent = "Logged in";
          loginBtn.href = "#";
          loginBtn.setAttribute("aria-pressed", "true");
          loginBtn.classList.add("is-logged-in");
          // prevent navigating when already logged in
          loginBtn.addEventListener("click", (e) => e.preventDefault());
        }
        if (logoutForm) logoutForm.style.display = "";
      } else {
        if (loginBtn) {
          loginBtn.textContent = "Login to Monkeytype";
          loginBtn.href = "/join";
          loginBtn.removeAttribute("aria-pressed");
          loginBtn.classList.remove("is-logged-in");
        }
        if (logoutForm) logoutForm.style.display = "none";
      }
    } catch (e) {
      // best-effort; keep default UI
      console.warn("session check failed", e);
    }
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString();
    } catch {
      return "—";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
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
      const demo = document.getElementById("demoHint");
      if (j.mode === "demo") demo.hidden = false; else demo.hidden = true;
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load leaderboard.</td></tr>`;
      console.error(e);
    }
  }

  refreshBtn?.addEventListener("click", load);

  await Promise.all([updateLoginButton(), load()]);
})();
