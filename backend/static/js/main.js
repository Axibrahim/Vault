async function checkHealth() {
  const el = document.getElementById("status");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    el.textContent = "Server status: " + data.status;
  } catch (err) {
    el.textContent = "Server unreachable";
  }
}

checkHealth();