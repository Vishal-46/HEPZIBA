# Database Schema (Beginner Friendly)

## 1. Users Table
All people who log into the system—patients, doctors, admins.

| Field        | Type         | Description           |
|--------------|--------------|----------------------|
| id           | serial PK    | Unique user ID        |
| name         | text         | Full name             |
| email        | text (unique)| Login email           |
| password     | text (hashed)| Hashed password       |
| role         | text         | 'patient', 'doctor', or 'admin' |
| created_at   | timestamp    | When account made     |

## 2. Patients Table
Actual clinic patients—connects to a user (role = 'patient'), may have extra details.

| Field        | Type         | Description          |
|--------------|--------------|---------------------|
| id           | serial PK    | Unique patient ID    |
| user_id      | int (FK)     | Linked to Users table|
| dob          | date         | Date of birth        |
| allergies    | text         | Allergies info       |
| contact      | text         | Phone, WhatsApp, etc |
| address      | text         | Address (optional)   |

## 3. Appointments Table
Every scheduled meeting.

| Field        | Type         | Description              |
|--------------|--------------|-------------------------|
| id           | serial PK    | Unique appointment ID    |
| patient_id   | int (FK)     | Who is being seen       |
| doctor_id    | int (FK)     | Which doctor            |
| date_time    | timestamp    | When                    |
| status       | text         | pending/confirmed/done/cancelled |
| reason       | text         | Why the visit           |
| notes        | text         | (optional) Slot/remarks |

---

## Example Relationships
- Every patient must have a user (role = 'patient').
- Doctors/admins are users with different role.
- Appointments link to one patient and one doctor.

---

## How to Apply (First Time)
- Use any DB GUI (pgAdmin, TablePlus, DBeaver) or run SQL directly.
- For each table, run (in SQL):

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE patients (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  dob DATE,
  allergies TEXT,
  contact TEXT,
  address TEXT
);

CREATE TABLE appointments (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date_time TIMESTAMP NOT NULL,
  status TEXT DEFAULT 'pending',
  reason TEXT,
  notes TEXT
);
```
- You can add more fields/constraints as you grow!

---

**You now have a real, simple database foundation for your clinic software.**
- Start with these three tables.
- Add more as you move to records, billing, prescriptions, etc.
- Keep this file updated as your DB changes!

---
*Next: Backend & Folder Structure setup.*