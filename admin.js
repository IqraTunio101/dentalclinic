document.addEventListener('DOMContentLoaded', checkAuth);

async function checkAuth() {
  try {
    const res = await fetch('/api/admin/me');
    if (res.ok) {
      document.getElementById('loginScreen').classList.add('hidden');
      document.getElementById('dashScreen').classList.remove('hidden');
      nav('overview');
    } else {
      document.getElementById('loginScreen').classList.remove('hidden');
      document.getElementById('dashScreen').classList.add('hidden');
    }
  } catch (e) {
    console.error(e);
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: document.getElementById('lEmail').value, password: document.getElementById('lPass').value })
  });
  if (res.ok) checkAuth();
  else document.getElementById('lError').innerText = 'Invalid credentials';
});

async function logout() {
  await fetch('/api/admin/logout', { method: 'POST' });
  location.reload();
}

function nav(view) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  event.currentTarget.classList.add('active');
  const main = document.getElementById('mainContent');
  main.innerHTML = '<h2>Loading...</h2>';
  
  if (view === 'overview') loadOverview();
  if (view === 'appointments') loadAppointments();
  if (view === 'services') loadServices();
  if (view === 'dentists') loadDentists();
}

async function loadOverview() {
  const res = await fetch('/api/admin/dashboard');
  const data = await res.json();
  const main = document.getElementById('mainContent');
  
  let html = `<h2>Dashboard Overview</h2>
    <div style="display:flex; gap:20px; margin-bottom:30px;">
      <div class="clay-card" style="flex:1;"><h3>Total Appointments</h3><h2>${data.stats.total}</h2></div>
      <div class="clay-card" style="flex:1;"><h3>Pending Requests</h3><h2>${data.stats.pending}</h2></div>
      <div class="clay-card" style="flex:1;"><h3>Confirmed</h3><h2>${data.stats.confirmed}</h2></div>
    </div>
    <div class="clay-card">
      <h3>Recent Appointments</h3>
      <table>
        <tr><th>Ref</th><th>Patient</th><th>Service</th><th>Date</th><th>Time</th><th>Status</th></tr>
        ${data.recent.map(a => `
          <tr>
            <td>${a.bookingReference}</td>
            <td>${a.patientName}</td>
            <td>${a.serviceNameSnapshot}</td>
            <td>${a.appointmentDate}</td>
            <td>${a.startTime}</td>
            <td><span class="badge b-${a.status}">${a.status}</span></td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
  main.innerHTML = html;
}

async function loadAppointments() {
  const res = await fetch('/api/admin/appointments');
  const data = await res.json();
  const main = document.getElementById('mainContent');
  
  let html = `<h2>Manage Appointments</h2>
    <div class="clay-card">
      <table>
        <tr><th>Ref</th><th>Patient</th><th>Phone</th><th>Date & Time</th><th>Status</th><th>Actions</th></tr>
        ${data.map(a => `
          <tr>
            <td>${a.bookingReference}</td>
            <td>${a.patientName}</td>
            <td>${a.patientPhone}</td>
            <td>${a.appointmentDate} at ${a.startTime}</td>
            <td><span class="badge b-${a.status}">${a.status}</span></td>
            <td>
              <select onchange="updateStatus('${a._id}', this.value)">
                <option value="" disabled selected>Change Status</option>
                <option value="confirmed">Confirm</option>
                <option value="completed">Complete</option>
                <option value="cancelled">Cancel</option>
                <option value="rejected">Reject</option>
              </select>
            </td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
  main.innerHTML = html;
}

async function updateStatus(id, status) {
  if(!confirm(`Change status to ${status}?`)) return;
  await fetch(`/api/admin/appointments/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  loadAppointments();
}

async function loadServices() {
  const res = await fetch('/api/admin/services');
  const data = await res.json();
  const main = document.getElementById('mainContent');
  main.innerHTML = `<h2>Manage Services</h2>
    <div class="clay-card">
      <table>
        <tr><th>Name</th><th>Category</th><th>Price (PKR)</th><th>Duration (min)</th><th>Active</th></tr>
        ${data.map(s => `<tr><td>${s.name}</td><td>${s.category}</td><td>${s.price}</td><td>${s.durationMinutes}</td><td>${s.isActive ? 'Yes' : 'No'}</td></tr>`).join('')}
      </table>
    </div>
  `;
}

async function loadDentists() {
  const res = await fetch('/api/admin/dentists');
  const data = await res.json();
  const main = document.getElementById('mainContent');
  main.innerHTML = `<h2>Manage Dentists</h2>
    <div class="clay-card">
      <table>
        <tr><th>Name</th><th>Designation</th><th>Available Days</th><th>Hours</th></tr>
        ${data.map(d => `<tr><td>${d.name}</td><td>${d.designation}</td><td>${d.availableDays.join(', ')}</td><td>${d.workingHours.start} - ${d.workingHours.end}</td></tr>`).join('')}
      </table>
    </div>
  `;
}
