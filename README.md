# Hepziba Chest Clinic Management System

## Overview
The **Hepziba Chest Clinic** system is a specialized, comprehensive management platform designed for a pulmonology clinic in Nagercoil (Dr. T. Joseph Pratheeban). This system aims to digitize the clinic's workflow, including patient records, appointment scheduling, prescription management, medical inventory, and billing.

## Project Structure
The repository is structured as a monorepo containing the following key components:

- `/backend`: The core API backend built with **Node.js** and **Express**, connecting to a **PostgreSQL** database. Handles authentication, data management, and business logic.
- `/frontend/doctor-admin-web`: A **React** web application (powered by **Vite**) tailored for doctors and clinic administrators to manage the clinic, view patient histories, and handle appointments.
- `/frontend/patient-mobile`: A mobile application built with **React Native** and **Expo**, designed for patients to book appointments, view invoices, and manage their profiles.
- `/docs`, `/shared`, `/scripts`: Folders containing documentation, shared assets, and utility scripts.
- `db-schema.md` & `hepziba_schema.sql`: Documentation and SQL scripts for the database schema.
- `PROJECT_STATUS_REPORT.md`: A detailed report on the current development progress, feature completion matrix, and technical debt.

## Tech Stack
- **Backend:** Node.js, Express.js, PostgreSQL (with `pg` driver), JSON Web Tokens (JWT) for authentication, `bcrypt` for password hashing.
- **Web Frontend:** React, Vite, React Router, React Query, Axios.
- **Mobile Frontend:** React Native, Expo, React Navigation, React Native Paper.
- **Database:** PostgreSQL.

## Core Features (Current Status)
- **Authentication & Roles:** JWT-based Role-Based Access Control (RBAC) with 'patient', 'doctor', and 'admin' roles. *(Partially Working)*
- **Patient Registration & Profiles:** Managing patient details, medical history, and contact info. *(Partially Working)*
- **Appointment Management:** Scheduling and tracking patient appointments. *(Partially Working)*
- **Electronic Health Records (EHR):** Digital management of patient medical data. *(Partially Working)*
- **Billing/Invoicing, Inventory, Prescriptions:** *(Pending/Stubbed)*

## Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- PostgreSQL installed and running
- Expo CLI (for mobile app development)

### 1. Database Setup
1. Create a PostgreSQL database for the project.
2. Execute the `hepziba_schema.sql` script to set up the initial tables (`users`, `patients`, `appointments`).
   ```bash
   psql -U your_username -d your_database_name -f hepziba_schema.sql
   ```

### 2. Backend Setup
1. Navigate to the backend directory: `cd backend`
2. Install dependencies: `npm install`
3. Set up your environment variables by copying `.env.example` to `.env` and configuring your database credentials and JWT secrets.
4. Run the development server: `npm run dev`

### 3. Web Admin Panel Setup
1. Navigate to the web frontend: `cd frontend/doctor-admin-web`
2. Install dependencies: `npm install`
3. Run the development server: `npm run dev`

### 4. Patient Mobile App Setup
1. Navigate to the mobile frontend: `cd frontend/patient-mobile`
2. Install dependencies: `npm install`
3. Start the Expo server: `npm start` (Use the Expo Go app on your phone or an emulator to preview).

## Current Development Tasks
Refer to the `PROJECT_STATUS_REPORT.md` for immediate action items, which currently include locating the Doctor-Admin UI (now found!), verifying DB implementations, auditing code for validation/errors, and planning the deployment strategy.
