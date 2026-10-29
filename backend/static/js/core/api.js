// Every request to our backend goes through this helper.
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Request": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    // response had no JSON body
  }

  if (!res.ok) {
    const error = new Error((data && data.error) || "Request failed");
    error.status = res.status;
    throw error;
  }
  return data;
}