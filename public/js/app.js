const api = axios.create({
    baseURL: ''
});

// Interceptor for auth token
api.interceptors.request.use(config => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// UI Elements
const loginSection = document.getElementById('loginSection');
const dashboardSection = document.getElementById('dashboardSection');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const refreshProductsBtn = document.getElementById('refreshProductsBtn');

// Login Handler
loginBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    try {
        const response = await api.post('/api/users/login', { username, password });
        localStorage.setItem('token', response.data.token);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        showDashboard();
    } catch (err) {
        alert('Login failed. Check credentials.');
    }
});

// Logout Handler
logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    showLogin();
});

// Refresh Products
refreshProductsBtn.addEventListener('click', loadProducts);

function showLogin() {
    loginSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');
    logoutBtn.classList.add('hidden');
}

function showDashboard() {
    loginSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    checkHealth();
    loadProducts();
}

async function checkHealth() {
    try {
        const res = await api.get('/health');
        document.getElementById('healthStatus').innerText = res.data.status === 'ok' ? 'Healthy' : 'Degraded';
    } catch (err) {
        document.getElementById('healthStatus').innerText = 'Error';
        document.getElementById('healthStatus').classList.remove('text-success');
        document.getElementById('healthStatus').classList.add('text-error');
    }
}

async function loadProducts() {
    const tbody = document.getElementById('productsTableBody');
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">Loading...</td></tr>';
    
    try {
        const res = await api.get('/api/products');
        tbody.innerHTML = '';
        if (res.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center">No products found.</td></tr>';
            return;
        }
        res.data.forEach(product => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${product.id}</td>
                <td>${product.name}</td>
                <td>$${product.price}</td>
                <td><button class="btn btn-xs btn-info">View</button></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-error">Failed to load products.</td></tr>';
    }
}

// Initial check
if (localStorage.getItem('token')) {
    showDashboard();
} else {
    showLogin();
}
