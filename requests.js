const API_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const API_TOKEN = process.env.STRAPI_API_TOKEN || '';

export function toQueryString(params = {}) {
	const searchParams = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'object') {
			searchParams.set(key, JSON.stringify(value));
		} else {
			searchParams.set(key, String(value));
		}
	}

	const query = searchParams.toString();
	return query ? `?${query}` : '';
}

export async function strapiFetch(path, { method = 'GET', params, data, headers = {} } = {}) {
	const response = await fetch(`${API_URL}${path}${toQueryString(params)}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
			...headers,
		},
		body: data !== undefined ? JSON.stringify({ data }) : undefined,
	});

	const payload = await response.json();

	if (!response.ok) {
		const errorMessage =
			payload?.error?.message || `${method} ${path} failed with status ${response.status}`;
		throw new Error(errorMessage);
	}

	return payload;
}

function withPagination(params = {}, { page = 1, pageSize = 25, withCount = true } = {}) {
	return {
		...params,
		pagination: {
			page,
			pageSize,
			withCount,
		},
	};
}

function getPaginationMeta(response) {
	return response?.meta?.pagination || { page: 1, pageSize: 0, pageCount: 1, total: 0 };
}

function createCollectionRequests(endpoint) {
	const basePath = `/api/${endpoint}`;

	return {
		list: (params) => strapiFetch(basePath, { params }),
		listPage: (params, paginationOptions) =>
			strapiFetch(basePath, { params: withPagination(params, paginationOptions) }),
		listAll: async (params, { pageSize = 100, withCount = true } = {}) => {
			let currentPage = 1;
			let pageCount = 1;
			const allData = [];
			let lastResponse = null;

			do {
				lastResponse = await strapiFetch(basePath, {
					params: withPagination(params, {
						page: currentPage,
						pageSize,
						withCount,
					}),
				});

				allData.push(...(lastResponse?.data || []));
				const pagination = getPaginationMeta(lastResponse);
				pageCount = pagination.pageCount || 1;
				currentPage += 1;
			} while (currentPage <= pageCount);

			return {
				data: allData,
				meta: {
					pagination: {
						...getPaginationMeta(lastResponse),
						page: 1,
						pageSize,
						pageCount,
						total: allData.length,
					},
				},
			};
		},
		get: (id, params) => strapiFetch(`${basePath}/${id}`, { params }),
		create: (data) => strapiFetch(basePath, { method: 'POST', data }),
		update: (id, data) => strapiFetch(`${basePath}/${id}`, { method: 'PUT', data }),
		delete: (id) => strapiFetch(`${basePath}/${id}`, { method: 'DELETE' }),
	};
}

export const requests = {
	addresses: createCollectionRequests('addresses'),
	disambiguatedRelations: createCollectionRequests('disambiguated-relations'),
	guilds: createCollectionRequests('guilds'),
	instrumentsAdvertised: createCollectionRequests('instruments-advertised'),
	instrumentsKnown: createCollectionRequests('instruments-known'),
	makers: createCollectionRequests('makers'),
	memberships: createCollectionRequests('memberships'),
	relationMetas: createCollectionRequests('relation-metas'),
	relations: createCollectionRequests('relations'),
	relationTypeMetas: createCollectionRequests('relation-type-metas'),
	relationTypes: createCollectionRequests('relation-types'),
	scannedRelationMatches: createCollectionRequests('scanned-relation-matches'),
	sourcesInfo: createCollectionRequests('sources-info'),
	townLocations: createCollectionRequests('town-locations'),
};

export const requestExamples = {
	listMakersWithPagination: () => requests.makers.listPage({}, { page: 1, pageSize: 25 }),
	listMakersWithPopulate: () =>
		requests.makers.list({
			populate: ['addresses', 'guilds', 'relation_targets'],
			pagination: { page: 1, pageSize: 10 },
		}),
	filterMakersByName: (name = 'Stradivari') =>
		requests.makers.list({
			filters: {
				$or: [
					{ surname: { $containsi: name } },
					{ first_name: { $containsi: name } },
				],
			},
			sort: ['surname:asc', 'first_name:asc'],
			pagination: { page: 1, pageSize: 20 },
		}),
	getSingleMakerWithRelations: (id) =>
		requests.makers.get(id, {
			populate: '*',
		}),
	listRelationsWithTargetMaker: () =>
		requests.relations.list({
			populate: ['maker', 'target_maker', 'relation_type', 'relation_meta'],
			pagination: { page: 1, pageSize: 25 },
		}),
	fetchAllGuildsAcrossPages: () =>
		requests.guilds.listAll(
			{ sort: ['name:asc'] },
			{ pageSize: 100 }
		),
	createMaker: () =>
		requests.makers.create({
			surname: 'Maker',
			first_name: 'Example',
		}),
	updateMaker: (id) =>
		requests.makers.update(id, {
			surname: 'Updated',
			first_name: 'Maker',
		}),
	deleteMaker: (id) => requests.makers.delete(id),
};