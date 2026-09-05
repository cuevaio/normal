export const emptyDirectoryResponse = {
  success: true,
  data: {
    items: [],
    pagination: {
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    },
  },
} as const;

export const contactsDirectoryResponse = {
  success: true,
  data: {
    items: [
      {
        jid: "15550199@s.whatsapp.net",
        name: "Ada",
        notify: "Ada Lovelace",
        verifiedName: null,
        imgUrl: "https://provider.invalid/ada.jpg",
        status: "provider-only status",
      },
      {
        jid: "98555123@lid",
        name: null,
        notify: "Grace",
        verifiedName: "Grace Hopper",
        imgUrl: null,
        status: null,
      },
    ],
    pagination: {
      total: 2,
      page: 1,
      limit: 100,
      totalPages: 1,
    },
  },
} as const;

export const groupsDirectoryResponse = {
  success: true,
  data: {
    items: [
      {
        jid: "120363123456789012@g.us",
        name: "Family",
        imgUrl: "https://provider.invalid/family.jpg",
      },
    ],
    pagination: {
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    },
  },
} as const;

export const malformedDirectoryResponse = {
  success: true,
  data: {
    items: [{ jid: 42, name: ["not", "a", "name"] }],
    pagination: {
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    },
  },
} as const;

export const largeDirectoryResponseBody = JSON.stringify({
  success: true,
  data: "x".repeat(1_048_576),
});

export const paginatedContactsFirstPage = {
  success: true,
  data: {
    items: [
      {
        jid: "15550199@s.whatsapp.net",
        name: "Ada",
      },
    ],
    pagination: {
      total: 2,
      page: 1,
      limit: 1,
      totalPages: 2,
    },
  },
} as const;

export const emptyPaginatedContactsFirstPage = {
  success: true,
  data: {
    items: [],
    pagination: {
      total: 2,
      page: 1,
      limit: 1,
      totalPages: 2,
    },
  },
} as const;

export const paginatedContactsSecondPage = {
  success: true,
  data: {
    items: [
      {
        jid: "15550200@s.whatsapp.net",
        name: "Grace",
      },
    ],
    pagination: {
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    },
  },
} as const;

export const duplicatePaginatedContactsSecondPage = {
  ...paginatedContactsSecondPage,
  data: {
    ...paginatedContactsSecondPage.data,
    items: paginatedContactsFirstPage.data.items,
  },
} as const;

export const changedPaginatedContactsSecondPage = {
  ...paginatedContactsSecondPage,
  data: {
    ...paginatedContactsSecondPage.data,
    pagination: {
      total: 3,
      page: 2,
      limit: 1,
      totalPages: 3,
    },
  },
} as const;

export const duplicateContactsFirstPage = {
  success: true,
  data: {
    items: [
      paginatedContactsFirstPage.data.items[0],
      paginatedContactsFirstPage.data.items[0],
    ],
    pagination: {
      total: 2,
      page: 1,
      limit: 100,
      totalPages: 1,
    },
  },
} as const;

export const transientDirectoryResponses = [
  { status: 503 },
  { status: 200, body: emptyDirectoryResponse },
] as const;

export const throttledDirectoryResponses = [
  { retryAfter: "0", status: 429 },
  { retryAfter: "0", status: 429 },
  { retryAfter: "99", status: 429 },
] as const;
