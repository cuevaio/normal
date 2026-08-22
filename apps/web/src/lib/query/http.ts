export const authorizedJson = async ({
  init,
  token,
  url,
}: {
  readonly init?: RequestInit;
  readonly token: string;
  readonly url: string;
}): Promise<{
  readonly body: unknown;
  readonly ok: boolean;
  readonly status: number;
}> => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    ...init,
    headers,
  });
  return {
    body: await response.json(),
    ok: response.ok,
    status: response.status,
  };
};
