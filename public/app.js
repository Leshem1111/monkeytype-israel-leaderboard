const body = document.getElementById("lb-body");
const refreshBtn = document.getElementById("refreshBtn");
const demoHint = document.getElementById("demoHint");

async function getLeaderboard() {
  const r = await fetch("/api/leaderboard");
  const data = await r.json();
  if (data.mode === "demo") demoHint.hidden = false;

  const rows = (data.users || []).map((u, i) => {
    const date = new Date(u.timestamp);
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${Number(u.wpm15).toFixed(0)}</td>
        <td>${Number(u.accuracy).toFixed(2)}%</td>
        <td title="${date.toISOString()}">${date.toLocaleString()}</td>
      </tr>
    `;
  }).join("");

  body.innerHTML = rows || `<tr><td colspan="5" class="muted">No users yet. Be the first to sign in!</td></tr>`;
}

function escapeHtml(s){
  return s?.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) ?? "";
}

refreshBtn?.addEventListener("click", () => getLeaderboard());

// Initial load
getLeaderboard();

// Auto refresh every 2 minutes (adjust if you’d like)
setInterval(getLeaderboard, 2 * 60 * 1000);
