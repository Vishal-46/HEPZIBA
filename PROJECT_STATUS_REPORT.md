# Project Status Report: Hepziba Chest Clinic

## 1. Project Purpose
The **Hepziba Chest Clinic** system is a specialized management platform for Dr. T. Joseph Pratheeban's pulmonology clinic in Nagercoil. It digitizes patient registration with clinical vitals (SpO2, BP), token-based appointment scheduling, digital prescriptions with dosage timing flags, medical inventory tracking with reorder alerts, and itemized billing/invoicing.

## 2. Feature Completion Matrix
| Module | Status | Notes |
| :--- | :--- | :--- |
| **Auth & Security** | Completed | JWT access + rotating refresh tokens, RBAC (`patient`, `doctor`, `admin`), Google OAuth. |
| **Walk-in Patient Registration** | Completed | Full demographic & clinical vitals (Name, Age, Sex, Address, Mobile, Photo, Aadhaar, Height, Weight, BP, SpO2) with auto-generated non-guessable `HEP-XXXXXX` codes. |
| **Appointment Scheduling & Tokens** | Completed | Patient self-booking & Admin front-desk booking with daily doctor token allocation. |
| **Billing & Invoicing** | Completed | Admin invoice generator with auto-calculation, line items (Medicine, Exp date, Unit, MRP, Quantity, Total), invoice history, and printable clinic receipt. |
| **Electronic Health Records (EHR)** | Completed | Integrated EHR viewer for Doctor and Admin (Vitals, Visit history, Prescriptions, Invoices). |
| **Prescriptions** | Completed | Doctor digital prescription writing with dosage timing flags (M, A, E, N, Before/After food) & PDF/Print sheet. |
| **Inventory Management** | Completed | Stock tracking, reorder alert threshold, and item addition. |
| **Doctor-Admin Web UI** | Completed | Responsive React/Vite dashboard with tabs for Dashboard Queue, Patients Directory, Billing & Invoicing, Inventory, and Settings. |
| **Patient Mobile App** | Working | React Native / Expo app for patient self-service (profile, appointments, invoices, prescriptions). |

## 3. Current Architecture
* **Stack:** Node.js/Express API, PostgreSQL (Supabase pooler / standard pg), React + Vite (Doctor/Admin Web), React Native + Expo (Patient Mobile).
* **Auth:** Stateless JWT + DB-backed refresh tokens, Google OAuth.
* **Database:** Schema migrations `001_hospital_alignment.sql`, `002_fix_doctors_and_constraints.sql`, and `005_session_tokens.sql`.
* **Print Engine:** Native browser printable templates for prescriptions (`prescriptionPrint.ts`) and billing receipts (`invoicePrint.ts`).

