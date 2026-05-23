import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { API_BASE_URL } from '../config/api';
import FormField from '../components/FormField';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';

type User = { id: number; name: string; email: string; role: 'patient' | 'doctor' | 'admin' };

type Appointment = {
  id: number;
  scheduled_at?: string;
  scheduled_at_effective?: string;
  date_time?: string;
  status: 'pending' | 'confirmed' | 'done' | 'cancelled';
  reason?: string;
  doctor_name?: string;
  token_number?: number;
};

type Doctor = { doctor_id: number; name: string; specialty?: string };

type PatientProfile = {
  patient_code?: string;
  name: string;
  email: string;
  age?: number;
  sex?: string;
  address?: string;
  mobile?: string;
  aadhar_number?: string;
  height_cm?: number;
  weight_kg?: number;
  bp?: string;
  spo2?: number;
};

type Prescription = { id: number; doctor_name?: string; prescribed_on?: string; items: Array<{ medicine_name: string }> };
type Invoice = { id: number; invoice_date?: string; total_amount?: number; status?: string };

type Props = { token: string; user: User; onLogout: () => void };
type TabKey = 'home' | 'book' | 'records' | 'profile';

const PRIORITY_OPTIONS = ['normal', 'urgent'];

export default function PatientHomeScreen({ token, user, onLogout }: Props) {
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;

  const [tab, setTab] = useState<TabKey>('home');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');

  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(null);
  const [reasonInput, setReasonInput] = useState('Respiratory consultation');
  const [symptomsInput, setSymptomsInput] = useState('');
  const [priorityInput, setPriorityInput] = useState('normal');
  const [appointmentDate, setAppointmentDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({
    name: '', email: '', age: '', sex: '', address: '', mobile: '', aadhar_number: '', height_cm: '', weight_kg: '', bp: '', spo2: '',
  });

  const apiGet = useCallback(async (url: string) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error ?? 'Request failed');
    return payload;
  }, [token]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      const [apps, docs, me, rx, bills] = await Promise.allSettled([
        apiGet(`${API_BASE_URL}/appointments/my`),
        apiGet(`${API_BASE_URL}/appointments/catalog/doctors`),
        apiGet(`${API_BASE_URL}/patients/me`),
        apiGet(`${API_BASE_URL}/prescriptions/my`),
        apiGet(`${API_BASE_URL}/billing/my`),
      ]);

      const appsData = apps.status === 'fulfilled' && Array.isArray(apps.value) ? apps.value : [];
      const docsData = docs.status === 'fulfilled' && Array.isArray(docs.value) ? docs.value : [];
      const meData = me.status === 'fulfilled' ? me.value : null;
      const rxData = rx.status === 'fulfilled' && Array.isArray(rx.value) ? rx.value : [];
      const billsData = bills.status === 'fulfilled' && Array.isArray(bills.value) ? bills.value : [];

      setAppointments(appsData);
      setDoctors(docsData);
      setProfile(meData || null);
      setPrescriptions(rxData);
      setInvoices(billsData);

      if (rx.status === 'rejected') {
        setInfoText('Prescriptions are temporarily unavailable. Other sections are still working.');
      }

      if (meData) {
        setProfileDraft({
          name: meData.name || '', email: meData.email || '', age: meData.age ? String(meData.age) : '', sex: meData.sex || '', address: meData.address || '',
          mobile: meData.mobile || '', aadhar_number: meData.aadhar_number || '', height_cm: meData.height_cm ? String(meData.height_cm) : '',
          weight_kg: meData.weight_kg ? String(meData.weight_kg) : '', bp: meData.bp || '', spo2: meData.spo2 ? String(meData.spo2) : '',
        });
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [apiGet]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const now = new Date();
    const rounded = new Date(now);
    rounded.setMinutes(now.getMinutes() + (30 - (now.getMinutes() % 30)));
    rounded.setSeconds(0);
    rounded.setMilliseconds(0);
    if (appointmentDate.getTime() < now.getTime()) {
      setAppointmentDate(rounded);
    }
  }, [appointmentDate]);

  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return appointments
      .filter((a) => getAppointmentDate(a)?.getTime() && (getAppointmentDate(a)?.getTime() || 0) >= now && a.status !== 'done' && a.status !== 'cancelled')
      .sort((a, b) => (getAppointmentDate(a)?.getTime() || 0) - (getAppointmentDate(b)?.getTime() || 0))[0];
  }, [appointments]);

  const selectedDoctor = doctors.find((d) => d.doctor_id === selectedDoctorId) || null;

  const submitBooking = async () => {
    if (!selectedDoctorId) return setErrorText('Please select a doctor first.');
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      if (!PRIORITY_OPTIONS.includes(priorityInput.trim().toLowerCase())) {
        throw new Error('Priority must be normal or urgent');
      }

      const profileContext = profile
        ? `Age:${profile.age || '-'} Sex:${profile.sex || '-'} BP:${profile.bp || '-'} SpO2:${profile.spo2 || '-'} Mobile:${profile.mobile || '-'}`
        : '';
      const notes = `Priority:${priorityInput}; Symptoms:${symptomsInput || '-'}; ${profileContext}`;

      const response = await fetch(`${API_BASE_URL}/appointments/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          doctor_id: selectedDoctorId,
          scheduled_at: appointmentDate.toISOString(),
          reason: reasonInput.trim() || 'Respiratory consultation',
          notes,
        }),
      });
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(payload?.error ?? 'Booking failed');

      setInfoText(`Appointment booked with ${selectedDoctor?.name || 'doctor'}. Token #${payload.appointment?.token_number || '-'}`);
      setShowBookModal(false);
      await loadAll();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Booking failed');
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async () => {
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      if (profileDraft.mobile && !/^\d{10,15}$/.test(profileDraft.mobile)) {
        throw new Error('Mobile must be 10-15 digits');
      }
      if (profileDraft.aadhar_number && !/^\d{12}$/.test(profileDraft.aadhar_number)) {
        throw new Error('Aadhar must be exactly 12 digits');
      }
      if (profileDraft.spo2) {
        const spo2 = Number(profileDraft.spo2);
        if (Number.isNaN(spo2) || spo2 < 0 || spo2 > 100) throw new Error('SpO2 must be between 0 and 100');
      }

      const response = await fetch(`${API_BASE_URL}/patients/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: profileDraft.name,
          email: profileDraft.email,
          age: profileDraft.age ? Number(profileDraft.age) : undefined,
          sex: profileDraft.sex || undefined,
          address: profileDraft.address || undefined,
          mobile: profileDraft.mobile || undefined,
          aadhar_number: profileDraft.aadhar_number || undefined,
          height_cm: profileDraft.height_cm ? Number(profileDraft.height_cm) : undefined,
          weight_kg: profileDraft.weight_kg ? Number(profileDraft.weight_kg) : undefined,
          bp: profileDraft.bp || undefined,
          spo2: profileDraft.spo2 ? Number(profileDraft.spo2) : undefined,
        }),
      });
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(payload?.error ?? 'Profile update failed');
      setInfoText('Profile updated successfully.');
      await loadAll();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Profile update failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={[s.headerRow, { paddingTop: topInset + SPACING.s }]}>
        <View style={s.headerTextWrap}>
          <Text style={s.heading}>Hello, {profile?.name || user.name}</Text>
          <Text style={s.subHeading}>{profile?.patient_code || 'Patient dashboard'}</Text>
        </View>
        <TouchableOpacity style={s.logoutBtn} onPress={onLogout} activeOpacity={0.8}>
          <Text style={s.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>

      {!!infoText && <Text style={s.infoText}>{infoText}</Text>}
      {!!errorText && <Text style={s.errorText}>{errorText}</Text>}

      <ScrollView contentContainerStyle={s.scrollBody}>
        {loading && <ActivityIndicator color={COLOR.primary} style={{ marginBottom: SPACING.s }} />}

        {tab === 'home' && (
          <>
            <View style={s.card}>
              <Text style={s.cardLabel}>Next Appointment</Text>
              {nextAppointment ? (
                <>
                  <Text style={s.cardTitle}>{formatDate(nextAppointment)}</Text>
                  <Text style={s.cardMeta}>Doctor: {nextAppointment.doctor_name || 'Assigned doctor'}</Text>
                  <Text style={s.cardMeta}>Token: #{nextAppointment.token_number || '-'}</Text>
                  <Text style={s.cardMeta}>Status: {nextAppointment.status}</Text>
                </>
              ) : (
                <Text style={s.cardMeta}>No upcoming appointments.</Text>
              )}
            </View>
            <View style={s.quickActions}>
              <TouchableOpacity style={[s.primaryBtn, s.fullWidthButton]} onPress={() => setShowBookModal(true)} activeOpacity={0.85}>
                <Text style={s.primaryBtnText}>Book Appointment</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.secondaryBtn, s.fullWidthButton]} onPress={() => setTab('records')} activeOpacity={0.85}>
                <Text style={s.secondaryBtnText}>View Records</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {tab === 'book' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Choose Doctor</Text>
            {doctors.length ? doctors.map((doctor) => (
              <TouchableOpacity
                key={doctor.doctor_id}
                onPress={() => setSelectedDoctorId(doctor.doctor_id)}
                style={[s.doctorChip, selectedDoctorId === doctor.doctor_id && s.doctorChipActive]}
                activeOpacity={0.8}
              >
                <Text style={s.doctorChipTitle}>{doctor.name}</Text>
                <Text style={s.doctorChipMeta}>{doctor.specialty || 'General consultation'}</Text>
              </TouchableOpacity>
            )) : <Text style={s.cardMeta}>No doctors listed.</Text>}

            <View style={s.datetimeRow}>
              <TouchableOpacity style={[s.secondaryBtn, s.flexButton]} onPress={() => setShowDatePicker(true)}>
                <Text style={s.secondaryBtnText}>Pick Date</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.secondaryBtn, s.flexButton]} onPress={() => setShowTimePicker(true)}>
                <Text style={s.secondaryBtnText}>Pick Time</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.cardMeta}>Selected: {appointmentDate.toLocaleString()}</Text>

            <FormField label="Reason" value={reasonInput} onChangeText={setReasonInput} />
            <FormField label="Symptoms" value={symptomsInput} onChangeText={setSymptomsInput} multiline />
            <View style={s.priorityRow}>
              {PRIORITY_OPTIONS.map((item) => (
                <TouchableOpacity
                  key={item}
                  onPress={() => setPriorityInput(item)}
                  style={[s.priorityChip, priorityInput === item && s.priorityChipActive]}
                  activeOpacity={0.8}
                >
                  <Text style={[s.priorityChipText, priorityInput === item && s.priorityChipTextActive]}>
                    {item.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={s.primaryBtn} onPress={submitBooking} activeOpacity={0.85}>
              <Text style={s.primaryBtnText}>Confirm Booking</Text>
            </TouchableOpacity>
          </View>
        )}

        {tab === 'records' && (
          <>
            <SectionCard title="Appointments">
              {appointments.length ? appointments.map((app) => (
                <View key={app.id} style={s.rowItem}>
                  <Text style={s.rowTitle}>{formatDate(app)}</Text>
                  <Text style={s.rowMeta}>Doctor: {app.doctor_name || '-'}</Text>
                  <Text style={s.rowMeta}>Token: #{app.token_number || '-'}</Text>
                  <Text style={s.rowMeta}>Status: {app.status}</Text>
                </View>
              )) : <Text style={s.rowMeta}>No appointments yet.</Text>}
            </SectionCard>

            <SectionCard title="Prescriptions">
              {prescriptions.length ? prescriptions.map((p) => (
                <View key={p.id} style={s.rowItem}>
                  <Text style={s.rowTitle}>{p.doctor_name || 'Doctor'}</Text>
                  <Text style={s.rowMeta}>{p.prescribed_on ? new Date(p.prescribed_on).toLocaleString() : ''}</Text>
                  <Text style={s.rowMeta}>{p.items.map((i) => i.medicine_name).join(', ') || 'No items'}</Text>
                </View>
              )) : <Text style={s.rowMeta}>No prescriptions yet.</Text>}
            </SectionCard>

            <SectionCard title="Invoices">
              {invoices.length ? invoices.map((invoice) => (
                <View key={invoice.id} style={s.rowItem}>
                  <Text style={s.rowTitle}>Invoice #{invoice.id}</Text>
                  <Text style={s.rowMeta}>{invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString() : ''}</Text>
                  <Text style={s.rowMeta}>Amount: Rs {Number(invoice.total_amount || 0).toFixed(2)}</Text>
                  <Text style={s.rowMeta}>Status: {invoice.status || 'unpaid'}</Text>
                </View>
              )) : <Text style={s.rowMeta}>No invoices yet.</Text>}
            </SectionCard>
          </>
        )}

        {tab === 'profile' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Patient Details</Text>
            <FormField label="Name" value={profileDraft.name} onChangeText={(v) => updateDraft(setProfileDraft, 'name', v)} />
            <FormField label="Email" value={profileDraft.email} onChangeText={(v) => updateDraft(setProfileDraft, 'email', v)} keyboardType="email-address" />
            <FormField label="Age" value={profileDraft.age} onChangeText={(v) => updateDraft(setProfileDraft, 'age', v)} keyboardType="numeric" />
            <FormField label="Sex" value={profileDraft.sex} onChangeText={(v) => updateDraft(setProfileDraft, 'sex', v)} />
            <FormField label="Address" value={profileDraft.address} onChangeText={(v) => updateDraft(setProfileDraft, 'address', v)} />
            <FormField label="Mobile" value={profileDraft.mobile} onChangeText={(v) => updateDraft(setProfileDraft, 'mobile', v)} keyboardType="phone-pad" />
            <FormField label="Aadhar" value={profileDraft.aadhar_number} onChangeText={(v) => updateDraft(setProfileDraft, 'aadhar_number', v)} keyboardType="numeric" />
            <FormField label="Height (cm)" value={profileDraft.height_cm} onChangeText={(v) => updateDraft(setProfileDraft, 'height_cm', v)} keyboardType="numeric" />
            <FormField label="Weight (kg)" value={profileDraft.weight_kg} onChangeText={(v) => updateDraft(setProfileDraft, 'weight_kg', v)} keyboardType="numeric" />
            <FormField label="BP" value={profileDraft.bp} onChangeText={(v) => updateDraft(setProfileDraft, 'bp', v)} />
            <FormField label="SpO2" value={profileDraft.spo2} onChangeText={(v) => updateDraft(setProfileDraft, 'spo2', v)} keyboardType="numeric" />
            <TouchableOpacity style={s.primaryBtn} onPress={saveProfile} activeOpacity={0.85}>
              <Text style={s.primaryBtnText}>Save Profile</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <View style={s.bottomTabs}>
        <Tab label="Home" active={tab === 'home'} onPress={() => setTab('home')} />
        <Tab label="Book" active={tab === 'book'} onPress={() => setTab('book')} />
        <Tab label="Records" active={tab === 'records'} onPress={() => setTab('records')} />
        <Tab label="Profile" active={tab === 'profile'} onPress={() => setTab('profile')} />
      </View>

      <Modal visible={showBookModal} transparent animationType="slide">
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.cardTitle}>Book Appointment</Text>
            <Text style={s.cardMeta}>Open full booking to choose doctor, date, and notes.</Text>
            <TouchableOpacity style={s.primaryBtn} onPress={() => { setTab('book'); setShowBookModal(false); }}>
              <Text style={s.primaryBtnText}>Open Booking</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.secondaryBtn} onPress={() => setShowBookModal(false)}>
              <Text style={s.secondaryBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {showDatePicker && (
        <DateTimePicker
          mode="date"
          value={appointmentDate}
          minimumDate={new Date()}
          onChange={(_, date) => {
            setShowDatePicker(Platform.OS === 'ios');
            if (date) setAppointmentDate(date);
          }}
        />
      )}
      {showTimePicker && (
        <DateTimePicker
          mode="time"
          value={appointmentDate}
          onChange={(_, date) => {
            setShowTimePicker(Platform.OS === 'ios');
            if (date) {
              const merged = new Date(appointmentDate);
              merged.setHours(date.getHours());
              merged.setMinutes(date.getMinutes());
              setAppointmentDate(merged);
            }
          }}
        />
      )}
    </SafeAreaView>
  );
}

function updateDraft(setter: React.Dispatch<React.SetStateAction<Record<string, string>>>, key: string, value: string) {
  setter((prev) => ({ ...prev, [key]: value }));
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.tab} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.tabText, active && s.tabActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function getAppointmentDate(app: Appointment): Date | null {
  const raw = app.scheduled_at_effective || app.scheduled_at || app.date_time;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(app: Appointment): string {
  const d = getAppointmentDate(app);
  return d ? d.toLocaleString() : 'Date unavailable';
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.background },
  headerRow: {
    paddingHorizontal: SPACING.l,
    paddingBottom: SPACING.m,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTextWrap: { flex: 1, paddingRight: SPACING.s },
  heading: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 24 },
  subHeading: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 14, marginTop: SPACING.xs },
  logoutBtn: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    ...SHADOW.button,
  },
  logoutText: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 13 },
  scrollBody: { paddingHorizontal: SPACING.l, paddingBottom: 100 },
  card: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.l,
    marginBottom: SPACING.m,
    ...SHADOW.card,
  },
  cardLabel: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 13, marginBottom: SPACING.s },
  cardTitle: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 18, marginBottom: SPACING.s },
  cardMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  quickActions: { flexDirection: 'column', gap: SPACING.s, marginBottom: SPACING.m },
  primaryBtn: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.m,
    marginTop: SPACING.s,
  },
  primaryBtnText: { color: COLOR.surface, fontFamily: FONT.bold, fontSize: 15 },
  secondaryBtn: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.m,
    marginTop: SPACING.s,
    ...SHADOW.button,
  },
  secondaryBtnText: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 15 },
  datetimeRow: { flexDirection: 'row', gap: SPACING.s },
  priorityRow: {
    flexDirection: 'row',
    gap: SPACING.s,
    marginTop: SPACING.s,
  },
  priorityChip: {
    flex: 1,
    paddingVertical: SPACING.s,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.accent,
    alignItems: 'center',
    backgroundColor: COLOR.surface,
  },
  priorityChipActive: {
    backgroundColor: COLOR.primary,
    borderColor: COLOR.primary,
  },
  priorityChipText: {
    color: COLOR.primary,
    fontFamily: FONT.medium,
    fontSize: 13,
  },
  priorityChipTextActive: {
    color: COLOR.surface,
    fontFamily: FONT.bold,
  },
  flexButton: { flex: 1 },
  fullWidthButton: { width: '100%' },
  doctorChip: {
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    padding: SPACING.m,
    marginBottom: SPACING.s,
  },
  doctorChipActive: { backgroundColor: COLOR.background },
  doctorChipTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 15 },
  doctorChipMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 13, marginTop: SPACING.xs },
  rowItem: {
    borderTopWidth: 1,
    borderTopColor: COLOR.background,
    paddingTop: SPACING.s,
    marginTop: SPACING.s,
  },
  rowTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 15 },
  rowMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 13, marginTop: SPACING.xs },
  bottomTabs: {
    position: 'absolute',
    left: SPACING.l,
    right: SPACING.l,
    bottom: SPACING.m,
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.s,
    flexDirection: 'row',
    ...SHADOW.card,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: SPACING.s },
  tabText: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 12 },
  tabActive: { color: COLOR.text, fontFamily: FONT.bold },
  infoText: { color: COLOR.success, fontFamily: FONT.medium, fontSize: 13, marginHorizontal: SPACING.l, marginBottom: SPACING.xs },
  errorText: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 13, marginHorizontal: SPACING.l, marginBottom: SPACING.xs },
  modalWrap: { flex: 1, backgroundColor: 'rgba(47,52,65,0.28)', justifyContent: 'flex-end', padding: SPACING.l },
  modalCard: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.l, ...SHADOW.card },
});
