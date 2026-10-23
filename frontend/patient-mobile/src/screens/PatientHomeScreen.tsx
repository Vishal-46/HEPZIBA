import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TouchableOpacity,
  Pressable,
  Linking,
  SafeAreaView,
  View,
  ScrollView,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  Button,
  Card,
  Chip,
  Surface,
  Text,
} from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import { File, UploadType } from 'expo-file-system';
import { API_BASE_URL, CLOUDINARY_UPLOAD_PRESET, CLOUDINARY_UPLOAD_URL } from '../config/api';
import FormField from '../components/FormField';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';
import { Ionicons } from '@expo/vector-icons';
import { createStackNavigator } from '@react-navigation/stack';
import PrescriptionDetailScreen from './PrescriptionDetailScreen';
import InvoiceDetailScreen from './InvoiceDetailScreen';
import type { User } from '../utils/sessionTypes';

type Appointment = {
  id: number;
  scheduled_at?: string;
  scheduled_at_effective?: string;
  date_time?: string;
  status: 'pending' | 'confirmed' | 'done' | 'completed' | 'cancelled';
  reason?: string;
  notes?: string;
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
  photo_url?: string;
  aadhar_number?: string;
  height_cm?: number;
  weight_kg?: number;
  bp?: string;
  spo2?: number;
};

type Prescription = {
  id: number;
  doctor_name?: string;
  prescribed_on?: string;
  items: Array<{ medicine_name: string }>;
};
type Invoice = { id: number; invoice_date?: string; total_amount?: number; status?: string };

type Props = { token: string; user: User; onLogout: () => void };
type TabKey = 'home' | 'book' | 'records' | 'profile' | 'clinic';

const PRIORITY_OPTIONS = ['normal', 'urgent'];

// Generous touch target so the whole button answers, not just its label.
const HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const;
const CLINIC_DETAILS = {
  name: 'Hepziba Chest Clinic',
  doctor: 'Dr. T. Joseph Pratheeban, DCH, MD (Respiratory Medicine)',
  specialty: 'Pulmonologist & Bronchoscopist',
  address: 'Opposite to WCC Entrance, White House Street, Nagercoil',
  mobile: '9500907968',
};

const CLINIC_HIGHLIGHTS = [
  'Specialist chest and respiratory care',
  'Easy appointment requests with quick confirmation',
  'Your records and prescriptions in one place',
];

const HOW_TO_USE = [
  'Book Appointment: pick a doctor and time, add your reason and symptoms.',
  'Consult Doctor: visit the clinic at your scheduled time for consultation.',
  'View Records: check appointments, prescriptions, and bills anytime.',
  'Update Profile: keep your contact and health details updated.',
];

const BEFORE_VISIT = [
  'Bring any previous reports or test results.',
  'Keep your phone number active for updates.',
  'Arrive a little early for smooth check-in.',
];

const Stack = createStackNavigator();

function maskAadhaar(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return 'Not provided';
  if (digits.length < 4) return '••••';
  return `•••• •••• ${digits.slice(-4)}`;
}

export default function PatientHomeScreen(props: Props) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs">
        {() => <PatientHomeScreenContent {...props} />}
      </Stack.Screen>
      <Stack.Screen
        name="PrescriptionDetail"
        component={PrescriptionDetailScreen}
        options={{ title: 'Prescription', headerShown: true }}
      />
      <Stack.Screen
        name="InvoiceDetail"
        component={InvoiceDetailScreen}
        options={{ title: 'Invoice', headerShown: true }}
      />
    </Stack.Navigator>
  );
}

function PatientHomeScreenContent({ token, user, onLogout }: Props) {
  const navigation = useNavigation<any>();
  const topInset = Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0;
  const [tab, setTab] = useState<TabKey>('home');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');
  const [isOffline, setIsOffline] = useState(false);
  const [pushStatus, setPushStatus] = useState<{
    granted: boolean;
    status: string;
    token?: string | null;
    checked: boolean;
  }>({ granted: true, status: 'checking', checked: false });
  const [testingPush, setTestingPush] = useState(false);

  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(null);
  const [reasonInput, setReasonInput] = useState('');
  const [symptomsInput, setSymptomsInput] = useState('');
  const [priorityInput, setPriorityInput] = useState('normal');
  const [appointmentDate, setAppointmentDate] = useState(() => {
    const now = new Date();
    const rounded = new Date(now);
    rounded.setMinutes(now.getMinutes() + (30 - (now.getMinutes() % 30 || 30)));
    rounded.setSeconds(0, 0);
    return rounded.getTime() > now.getTime() ? rounded : new Date(now.getTime() + 30 * 60_000);
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [bookingInFlight, setBookingInFlight] = useState(false);

  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({
    name: '',
    email: '',
    age: '',
    sex: '',
    address: '',
    mobile: '',
    photo_url: '',
    aadhar_number: '',
    height_cm: '',
    weight_kg: '',
    bp: '',
    spo2: '',
  });
  const [photoUploading, setPhotoUploading] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const logoutRef = useRef(onLogout);
  logoutRef.current = onLogout;

  const authHeaders = useMemo(
    () => ({ Authorization: `Bearer ${token}` }),
    [token],
  );

  const apiGet = useCallback(
    async (url: string) => {
      let response: Response;
      try {
        response = await fetch(url, { headers: authHeaders });
      } catch {
        throw new Error('NETWORK_OFFLINE');
      }
      if (response.status === 401) {
        logoutRef.current();
        throw new Error('Session expired. Please sign in again.');
      }
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(apiErrorMessage(payload, 'Request failed'));
      return payload;
    },
    [authHeaders],
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorText('');
    setInfoText('');
    setIsOffline(false);
    try {
      const [apps, docs, me, rx, bills] = await Promise.allSettled([
        apiGet(`${API_BASE_URL}/appointments/my`),
        apiGet(`${API_BASE_URL}/appointments/catalog/doctors`),
        apiGet(`${API_BASE_URL}/patients/me`),
        apiGet(`${API_BASE_URL}/prescriptions/my`),
        apiGet(`${API_BASE_URL}/billing/my`),
      ]);

      const offlineHits = [apps, docs, me, rx, bills].filter(
        (r) => r.status === 'rejected' && String((r as any).reason?.message) === 'NETWORK_OFFLINE',
      ).length;
      if (offlineHits >= 3) {
        setIsOffline(true);
        setErrorText('You appear to be offline. Showing last loaded data.');
        return;
      }

      const appsData = apps.status === 'fulfilled' && Array.isArray(apps.value) ? apps.value : [];
      const docsData = docs.status === 'fulfilled' && Array.isArray(docs.value) ? docs.value : [];
      const meData = me.status === 'fulfilled' ? me.value : null;
      const rxData = rx.status === 'fulfilled' && Array.isArray(rx.value) ? rx.value : [];
      const billsData =
        bills.status === 'fulfilled' && Array.isArray(bills.value) ? bills.value : [];

      setAppointments(appsData);
      setDoctors(docsData);
      setProfile(meData || null);
      setPrescriptions(rxData);
      setInvoices(billsData);

      if (meData) {
        setProfileDraft({
          name: meData.name || '',
          email: meData.email || '',
          age: meData.age ? String(meData.age) : '',
          sex: meData.sex || '',
          address: meData.address || '',
          mobile: meData.mobile || '',
          photo_url: meData.photo_url || '',
          aadhar_number: meData.aadhar_number || '',
          height_cm: meData.height_cm ? String(meData.height_cm) : '',
          weight_kg: meData.weight_kg ? String(meData.weight_kg) : '',
          bp: meData.bp || '',
          spo2: meData.spo2 ? String(meData.spo2) : '',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load data';
      if (message === 'NETWORK_OFFLINE') {
        setIsOffline(true);
        setErrorText('You appear to be offline. Pull to retry when connected.');
      } else {
        setErrorText(message);
      }
    } finally {
      setLoading(false);
    }
  }, [apiGet]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Push registration + live handlers: a tap or foreground banner refreshes
  // visits immediately so admin decisions appear at once.
  useEffect(() => {
    let notifySub: { remove(): void } | null = null;
    let respondSub: { remove(): void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('../utils/pushRegistration');
        if (cancelled) return;
        const regRes = await mod.registerPushToken(token);
        if (!cancelled && regRes) {
          setPushStatus({
            granted: regRes.permissionStatus === 'granted',
            status: regRes.permissionStatus,
            token: regRes.token,
            checked: true,
          });
        }
        notifySub = await mod.addNotificationReceivedListener((notification) => {
          const content = notification?.request?.content;
          const title = content?.title;
          const body = content?.body;
          const text = body ? (title ? `${title}: ${body}` : body) : 'Update from clinic — refreshing your visits…';
          setInfoText(text);
          void apiGet(`${API_BASE_URL}/appointments/my`)
            .then((apps) => {
              if (Array.isArray(apps)) setAppointments(apps);
            })
            .catch(() => {});
          void apiGet(`${API_BASE_URL}/billing/my`)
            .then((bills) => {
              if (Array.isArray(bills)) setInvoices(bills);
            })
            .catch(() => {});
        });
        if (cancelled) return;
        respondSub = await mod.addNotificationResponseReceivedListener(() => {
          setTab('home');
          void loadAll();
        });
      } catch {
        // Push unavailable (web/simulator): polling below still applies.
      }
    })();
    return () => {
      cancelled = true;
      notifySub?.remove();
      respondSub?.remove();
    };
  }, [token, apiGet, loadAll]);

  // Live status: re-check visit decisions by itself every 30s so an admin
  // Accept/Decline flips pending → approved without manual refresh.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const apps = await apiGet(`${API_BASE_URL}/appointments/my`);
        if (Array.isArray(apps)) setAppointments(apps);
        const bills = await apiGet(`${API_BASE_URL}/billing/my`);
        if (Array.isArray(bills)) setInvoices(bills);
      } catch {
        // Silent: next tick retries; errors surface on full load.
      }
    }, 30000);
    return () => clearInterval(id);
  }, [apiGet]);

  // Transient messages are per-tab: clear on tab switch. Keeps isOffline/
  // offline banner untouched (persistent until reconnect).
  useEffect(() => {
    setInfoText('');
    setErrorText('');
  }, [tab]);

  // Auto-dismiss transient messages after ~5s. New messages reset the timer
  // via cleanup. Skipped while a slow action is in flight so a message the
  // user is reading does not vanish mid-action; the timer starts once the
  // action flags clear.
  useEffect(() => {
    if (!infoText && !errorText) return;
    if (bookingInFlight || photoUploading || loading) return;
    const timer = setTimeout(() => {
      setInfoText('');
      setErrorText('');
    }, 5000);
    return () => clearTimeout(timer);
  }, [infoText, errorText, bookingInFlight, photoUploading, loading]);

  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return appointments
      .filter((a) => {
        const d = getAppointmentDate(a);
        return d && d.getTime() >= now && a.status !== 'done' && a.status !== 'completed' && a.status !== 'cancelled';
      })
      .sort((a, b) => (getAppointmentDate(a)?.getTime() || 0) - (getAppointmentDate(b)?.getTime() || 0))[0];
  }, [appointments]);

  const selectedDoctor = doctors.find((d) => d.doctor_id === selectedDoctorId) || null;

  // Single-doctor clinic: no choosing needed. Auto-assign the first listed
  // doctor so booking never blocks on "Please select a doctor".
  useEffect(() => {
    if (selectedDoctorId === null && doctors.length > 0) {
      setSelectedDoctorId(doctors[0].doctor_id);
    }
  }, [doctors, selectedDoctorId]);

  const pendingBills = useMemo(
    () => invoices.filter((i) => (i.status || 'unpaid').toLowerCase() !== 'paid').length,
    [invoices],
  );

  const unpaidTotal = useMemo(
    () =>
      invoices
        .filter((i) => (i.status || 'unpaid').toLowerCase() !== 'paid')
        .reduce((sum, i) => sum + (Number(i.total_amount) || 0), 0),
    [invoices],
  );

  const profileGaps = useMemo(() => {
    if (!profile) return [];
    const gaps: string[] = [];
    if (!profile.mobile) gaps.push('mobile number');
    if (!profile.aadhar_number) gaps.push('Aadhaar');
    if (!profile.address) gaps.push('address');
    return gaps;
  }, [profile]);

  const latestRx = useMemo(() => {
    if (!prescriptions.length) return null;
    return [...prescriptions].sort(
      (a, b) =>
        new Date(b.prescribed_on || 0).getTime() - new Date(a.prescribed_on || 0).getTime(),
    )[0];
  }, [prescriptions]);

  const hasVitals = Boolean(
    profile && (profile.bp || profile.spo2 != null || profile.height_cm || profile.weight_kg),
  );

  const avatarUri = (
    profile?.photo_url ||
    (user as any)?.photo_url ||
    (user as any)?.avatar ||
    ''
  ).trim();

  // Reset the load-failure flag whenever the photo URI changes so a new
  // (fixed) URL gets a fresh chance to render.
  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUri]);

  const onDateChange = useCallback(
    (_event: any, selected?: Date) => {
      if (Platform.OS === 'android') setShowDatePicker(false);
      if (selected) {
        setAppointmentDate((prev) => {
          const next = new Date(prev);
          next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
          return next;
        });
      }
    },
    [],
  );

  const onTimeChange = useCallback(
    (_event: any, selected?: Date) => {
      if (Platform.OS === 'android') setShowTimePicker(false);
      if (selected) {
        setAppointmentDate((prev) => {
          const next = new Date(prev);
          next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
          return next;
        });
      }
    },
    [],
  );

  const submitBooking = async () => {
    if (bookingInFlight) return;
    const reason = reasonInput.trim();
    const symptoms = symptomsInput.trim();
    if (!reason) {
      setErrorText('Please enter a reason for your visit.');
      return;
    }
    if (!symptoms) {
      setErrorText('Please describe your symptoms.');
      return;
    }
    if (!PRIORITY_OPTIONS.includes(priorityInput.trim().toLowerCase())) {
      setErrorText('Priority must be normal or urgent.');
      return;
    }
    if (appointmentDate.getTime() <= Date.now()) {
      setErrorText('Please pick a future date and time for your appointment.');
      return;
    }
    setBookingInFlight(true);
    setErrorText('');
    setInfoText('');
    try {
      const profileContext = profile
        ? `Age:${profile.age || '-'} Sex:${profile.sex || '-'} BP:${profile.bp || '-'} SpO2:${profile.spo2 ?? '-'} Mobile:${profile.mobile || '-'}`
        : '';
      const notes = `Priority:${priorityInput}; Symptoms:${symptoms}; ${profileContext}`.trim();
      // Doctor is assigned server-side (single-doctor clinic); include it
      // only when already known.
      const doctorId = selectedDoctorId ?? doctors[0]?.doctor_id ?? null;

      let response: Response;
      try {
        response = await fetch(`${API_BASE_URL}/appointments/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...(doctorId ? { doctor_id: doctorId } : {}),
            scheduled_at: appointmentDate.toISOString(),
            reason,
            notes,
          }),
        });
      } catch {
        throw new Error('Cannot reach the server. Check your connection and try again.');
      }
      if (response.status === 401) {
        onLogout();
        throw new Error('Session expired. Please sign in again.');
      }
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(apiErrorMessage(payload, 'Booking failed'));

      setInfoText(
        'Request submitted — the clinic will confirm shortly. Watch Home for your visit status.',
      );
      setShowBookModal(false);
      setTab('home');
      await loadAll();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Booking failed');
    } finally {
      setBookingInFlight(false);
    }
  };

  const pickProfilePhoto = async () => {
    setErrorText('');
    let pickedUri: string | undefined;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setErrorText('Photo permission is needed to choose a profile picture.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
      });
      const cancelled =
        (result as any).canceled ?? (result as any).cancelled ?? false;
      if (cancelled) return;
      const asset = (result as any).assets?.[0];
      const uri: string | undefined = asset?.uri;
      if (!uri) {
        setErrorText('Could not read the selected image.');
        return;
      }
      pickedUri = uri;
      setPhotoUploading(true);
      const uploadedUrl = await uploadPhotoAsync(uri, asset?.mimeType);
      setProfileDraft((prev) => ({ ...prev, photo_url: uploadedUrl }));
      setInfoText(
        CLOUDINARY_UPLOAD_URL
          ? 'Photo uploaded.'
          : 'Photo selected. It will be saved with your profile.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Photo pick failed.';
      // No internet/DNS on the device: keep the photo locally so Save Profile
      // still works, and say so plainly instead of a native stack trace.
      if (pickedUri && /resolve host|no address|network|timed out|timeout|eai_again|enotfound|unreachable/i.test(message)) {
        setProfileDraft((prev) => ({ ...prev, photo_url: pickedUri as string }));
        setInfoText('No internet — photo kept locally. Re-pick when online to upload.');
      } else {
        setErrorText(message);
      }
    } finally {
      setPhotoUploading(false);
    }
  };

  const saveProfile = async () => {
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      const mobile = profileDraft.mobile.trim();
      const aadhaar = profileDraft.aadhar_number.replace(/\D/g, '');
      if (mobile && !/^\d{10,15}$/.test(mobile)) {
        throw new Error('Mobile must be 10-15 digits.');
      }
      if (aadhaar && !/^\d{12}$/.test(aadhaar)) {
        throw new Error('Aadhaar must be exactly 12 digits.');
      }
      if (profileDraft.spo2.trim()) {
        const spo2 = Number(profileDraft.spo2);
        if (Number.isNaN(spo2) || spo2 < 0 || spo2 > 100)
          throw new Error('SpO2 must be between 0 and 100.');
      }
      if (profileDraft.age.trim()) {
        const age = Number(profileDraft.age);
        if (!Number.isInteger(age) || age < 0 || age > 150)
          throw new Error('Age must be a whole number between 0 and 150.');
      }
      for (const key of ['height_cm', 'weight_kg'] as const) {
        if (profileDraft[key].trim()) {
          const n = Number(profileDraft[key]);
          if (Number.isNaN(n) || n <= 0)
            throw new Error(`${key === 'height_cm' ? 'Height' : 'Weight'} must be a positive number.`);
        }
      }

      let response: Response;
      try {
        response = await fetch(`${API_BASE_URL}/patients/me`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: profileDraft.name.trim() || undefined,
            email: profileDraft.email.trim() || undefined,
            age: profileDraft.age.trim() ? Number(profileDraft.age) : undefined,
            sex: profileDraft.sex.trim() || undefined,
            address: profileDraft.address.trim() || undefined,
            mobile: mobile || undefined,
            photo_url: profileDraft.photo_url.trim() || undefined,
            aadhar_number: aadhaar || undefined,
            height_cm: profileDraft.height_cm.trim() ? Number(profileDraft.height_cm) : undefined,
            weight_kg: profileDraft.weight_kg.trim() ? Number(profileDraft.weight_kg) : undefined,
            bp: profileDraft.bp.trim() || undefined,
            spo2: profileDraft.spo2.trim() ? Number(profileDraft.spo2) : undefined,
          }),
        });
      } catch {
        throw new Error('Cannot reach the server. Check your connection and try again.');
      }
      if (response.status === 401) {
        onLogout();
        throw new Error('Session expired. Please sign in again.');
      }
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(apiErrorMessage(payload, 'Profile update failed'));
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
      <Surface style={[s.headerRow, { paddingTop: topInset + SPACING.s }]}>
        <Pressable
          onPress={() => setTab('profile')}
          hitSlop={HIT_SLOP}
          accessibilityRole="imagebutton"
          accessibilityLabel="Open profile"
          style={s.avatarButton}
        >
          {avatarUri && !avatarFailed ? (
            <Image
              source={{ uri: avatarUri }}
              style={s.avatarImage}
              onError={() => setAvatarFailed(true)}
              accessibilityLabel="Open profile"
            />
          ) : (
            <Ionicons name="person-circle" size={48} color={COLOR.accent} />
          )}
        </Pressable>
        <View style={s.headerTextWrap}>
          <Text style={s.heading} numberOfLines={1} ellipsizeMode="tail">Hello, {profile?.name || user.name}</Text>
          <Text style={s.subHeading} numberOfLines={1} ellipsizeMode="tail">{profile?.patient_code || 'Patient dashboard'}</Text>
        </View>
        <Button mode="contained" onPress={onLogout} style={s.logoutBtn} labelStyle={s.logoutText} contentStyle={s.btnContent} hitSlop={HIT_SLOP}>
          Log out
        </Button>
      </Surface>

      {!!infoText && <Text style={s.infoText}>{infoText}</Text>}
      {!!errorText && <Text style={s.errorText}>{errorText}</Text>}
      {isOffline && (
        <View style={s.offlineBanner}>
          <Text style={s.offlineText}>Offline — data may be stale.</Text>
          <Button mode="outlined" compact onPress={() => void loadAll()} contentStyle={s.btnContent} hitSlop={HIT_SLOP}>
            Retry
          </Button>
        </View>
      )}

      {!pushStatus.granted && pushStatus.checked && Platform.OS !== 'web' && (
        <Pressable
          onPress={() => {
            void import('../utils/pushRegistration').then((m) => m.openNotificationSettings());
          }}
          style={s.notifWarningBanner}
        >
          <Ionicons name="notifications-off-outline" size={20} color="#b45309" />
          <View style={s.notifWarningWrap}>
            <Text style={s.notifWarningTitle}>Notifications are disabled</Text>
            <Text style={s.notifWarningSub}>Tap to allow notifications in phone Settings to get visit alerts.</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#b45309" />
        </Pressable>
      )}

      <ScrollView contentContainerStyle={s.scrollBody}>
        {loading && <ActivityIndicator color={COLOR.primary} style={{ marginBottom: SPACING.s }} />}

        {tab === 'home' && (
          <>
            <Card style={s.heroCard}>
              <Card.Content>
                <Text style={s.heroEyebrow}>Next Visit</Text>
                {nextAppointment ? (
                  <>
                    <Text style={s.heroTitle}>{formatDate(nextAppointment)}</Text>
                    <Text style={s.heroMeta}>{nextAppointment.doctor_name || 'Assigned doctor'}</Text>
                    <View style={s.metaRow}>
                      <Chip compact style={s.heroChip} textStyle={s.heroChipText}>
                        {nextAppointment.status === 'confirmed'
                          ? 'Approved ✓'
                          : nextAppointment.status === 'pending'
                            ? 'Waiting for approval'
                            : nextAppointment.status}
                      </Chip>
                    </View>
                    {!!nextAppointment.notes && (
                      <Text style={s.heroMeta}>Clinic message: {nextAppointment.notes}</Text>
                    )}
                    <Button
                      mode="contained"
                      onPress={() => setTab('records')}
                      style={s.heroBtn}
                      contentStyle={s.btnContent}
                      labelStyle={s.heroBtnText}
                      hitSlop={HIT_SLOP}
                    >
                      View Details
                    </Button>
                  </>
                ) : (
                  <>
                    <Text style={s.heroTitle}>No upcoming visits</Text>
                    <Text style={s.heroMeta}>Book a time that suits you.</Text>
                    <Button
                      mode="contained"
                      onPress={() => setTab('book')}
                      style={s.heroBtn}
                      contentStyle={s.btnContent}
                      labelStyle={s.heroBtnText}
                      hitSlop={HIT_SLOP}
                    >
                      Book Your Visit
                    </Button>
                  </>
                )}
              </Card.Content>
            </Card>
            {(unpaidTotal > 0 || profileGaps.length > 0) && (
              <Card style={s.card}>
                <Card.Content>
                  <Text style={s.cardLabel}>Needs Your Attention</Text>
                  {unpaidTotal > 0 && (
                    <TouchableOpacity onPress={() => setTab('records')} hitSlop={HIT_SLOP}>
                      <View style={s.attentionRow}>
                        <Ionicons name="receipt-outline" size={22} color={COLOR.primary} />
                        <View style={s.attentionText}>
                          <Text style={s.rowTitle}>
                            Rs {unpaidTotal.toFixed(2)} due across {pendingBills} bill{pendingBills === 1 ? '' : 's'}
                          </Text>
                          <Text style={s.rowMeta}>Tap to view invoices</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color={COLOR.accent} />
                      </View>
                    </TouchableOpacity>
                  )}
                  {profileGaps.length > 0 && (
                    <TouchableOpacity onPress={() => setTab('profile')} hitSlop={HIT_SLOP}>
                      <View style={s.attentionRow}>
                        <Ionicons name="person-outline" size={22} color={COLOR.primary} />
                        <View style={s.attentionText}>
                          <Text style={s.rowTitle}>
                            Profile missing: {profileGaps.join(', ')}
                          </Text>
                          <Text style={s.rowMeta}>Tap to complete</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color={COLOR.accent} />
                      </View>
                    </TouchableOpacity>
                  )}
                </Card.Content>
              </Card>
            )}
            {unpaidTotal <= 0 && profileGaps.length === 0 && (
              <Card style={s.card}>
                <Card.Content>
                  <Text style={s.cardLabel}>You&apos;re All Set</Text>
                  <Text style={s.cardMeta}>
                    No pending bills or missing details. We&apos;ll remind you here when something needs you.
                  </Text>
                </Card.Content>
              </Card>
            )}
            {hasVitals && (
              <Card style={s.card}>
                <Card.Content>
                  <Text style={s.cardLabel}>Health Snapshot</Text>
                  <View style={s.vitalsGrid}>
                    {!!profile?.bp && (
                      <View style={s.vitalTile}>
                        <Text style={s.vitalValue}>{profile.bp}</Text>
                        <Text style={s.vitalLabel}>BP</Text>
                      </View>
                    )}
                    {profile?.spo2 != null && (
                      <View style={s.vitalTile}>
                        <Text style={s.vitalValue}>{profile.spo2}%</Text>
                        <Text style={s.vitalLabel}>SpO2</Text>
                      </View>
                    )}
                    {!!profile?.height_cm && (
                      <View style={s.vitalTile}>
                        <Text style={s.vitalValue}>{profile.height_cm} cm</Text>
                        <Text style={s.vitalLabel}>Height</Text>
                      </View>
                    )}
                    {!!profile?.weight_kg && (
                      <View style={s.vitalTile}>
                        <Text style={s.vitalValue}>{profile.weight_kg} kg</Text>
                        <Text style={s.vitalLabel}>Weight</Text>
                      </View>
                    )}
                  </View>
                </Card.Content>
              </Card>
            )}
            <Card style={s.card}>
              <Card.Content>
                <Text style={s.cardLabel}>Latest Prescription</Text>
                {latestRx ? (
                  <TouchableOpacity
                    onPress={() => navigation.navigate('PrescriptionDetail', { prescription: latestRx })}
                    hitSlop={HIT_SLOP}
                  >
                    <View style={s.attentionRow}>
                      <Ionicons name="document-text-outline" size={22} color={COLOR.primary} />
                      <View style={s.attentionText}>
                        <Text style={s.rowTitle}>{latestRx.doctor_name || 'Doctor'}</Text>
                        <Text style={s.rowMeta}>
                          {[latestRx.prescribed_on ? new Date(latestRx.prescribed_on).toLocaleDateString() : '',
                            latestRx.items.map((i) => i.medicine_name).join(', ') || 'No items']
                            .filter(Boolean).join(' • ')}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={20} color={COLOR.accent} />
                    </View>
                  </TouchableOpacity>
                ) : (
                  <Text style={s.cardMeta}>No prescriptions yet.</Text>
                )}
              </Card.Content>
            </Card>
            
          </>
        )}

        {tab === 'book' && (
          <Card style={s.card}>
            <Card.Content>
              <Text style={s.cardTitle}>Pick a Date & Time</Text>

              <View style={s.datetimeRow}>
                <Button
                  mode="outlined"
                  style={s.flexButton}
                  contentStyle={s.btnContent}
                  hitSlop={HIT_SLOP}
                  onPress={() => {
                    setShowTimePicker(false);
                    setShowDatePicker(true);
                  }}
                >
                  Pick Date
                </Button>
                <Button
                  mode="outlined"
                  style={s.flexButton}
                  contentStyle={s.btnContent}
                  hitSlop={HIT_SLOP}
                  onPress={() => {
                    setShowDatePicker(false);
                    setShowTimePicker(true);
                  }}
                >
                  Pick Time
                </Button>
              </View>
              <Text style={s.cardMeta}>Selected: {appointmentDate.toLocaleString()}</Text>

              {showDatePicker && (
                <DateTimePicker
                  value={appointmentDate}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  minimumDate={new Date()}
                  onChange={onDateChange}
                />
              )}
              {showTimePicker && (
                <DateTimePicker
                  value={appointmentDate}
                  mode="time"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onTimeChange}
                />
              )}
              {Platform.OS === 'ios' && (showDatePicker || showTimePicker) && (
                <Button
                  mode="outlined"
                  style={s.secondaryBtn}
                  contentStyle={s.btnContent}
                  labelStyle={s.secondaryBtnText}
                  hitSlop={HIT_SLOP}
                  onPress={() => {
                    setShowDatePicker(false);
                    setShowTimePicker(false);
                  }}
                >
                  Done
                </Button>
              )}

              <FormField
                label="Reason"
                value={reasonInput}
                onChangeText={setReasonInput}
                placeholder="e.g. Respiratory consultation"
              />
              <FormField
                label="Symptoms"
                value={symptomsInput}
                onChangeText={setSymptomsInput}
                multiline
              />
              <View style={s.priorityRow}>
                {PRIORITY_OPTIONS.map((item) => {
                  const isActive = priorityInput === item;
                  return (
                    <Chip
                      key={item}
                      selected={isActive}
                      showSelectedCheck={false}
                      onPress={() => setPriorityInput(item)}
                      style={[s.priorityChip, isActive && s.priorityChipActive]}
                      textStyle={isActive ? s.priorityTextActive : s.priorityText}
                    >
                      {item.toUpperCase()}
                    </Chip>
                  );
                })}
              </View>
              <Button
                mode="contained"
                onPress={() => void submitBooking()}
                loading={bookingInFlight}
                disabled={bookingInFlight}
                style={s.primaryBtn}
                contentStyle={s.btnContent}
                labelStyle={s.primaryBtnText}
                hitSlop={HIT_SLOP}
              >
                Confirm Booking
              </Button>
            </Card.Content>
          </Card>
        )}

        {tab === 'records' && (
          <>
            <SectionCard title="Appointments">
              {appointments.length ? (
                appointments.map((app) => (
                  <Card key={app.id} style={{ marginBottom: SPACING.s }}>
                    <Card.Content>
                      <Text style={s.rowTitle}>{formatDate(app)}</Text>
                      <Text style={s.rowMeta}>Doctor: {app.doctor_name || '-'}</Text>
                      <Text style={s.rowMeta}>Status: {app.status}</Text>
                      {!!app.notes && <Text style={s.rowMeta}>Clinic message: {app.notes}</Text>}
                    </Card.Content>
                  </Card>
                ))
              ) : (
                <Text style={s.rowMeta}>No appointments yet.</Text>
              )}
            </SectionCard>

            <SectionCard title="Prescriptions">
              {prescriptions.length ? (
                prescriptions.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => navigation.navigate('PrescriptionDetail', { prescription: p })}
                  >
                    <Card style={{ marginBottom: SPACING.s }}>
                      <Card.Content>
                        <Text style={s.rowTitle}>{p.doctor_name || 'Doctor'}</Text>
                        <Text style={s.rowMeta}>
                          {p.prescribed_on ? new Date(p.prescribed_on).toLocaleString() : ''}
                        </Text>
                        <Text style={s.rowMeta}>
                          {p.items.map((i) => i.medicine_name).join(', ') || 'No items'}
                        </Text>
                      </Card.Content>
                    </Card>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={s.rowMeta}>No prescriptions yet.</Text>
              )}
            </SectionCard>

            <SectionCard title="Invoices">
              {invoices.length ? (
                invoices.map((invoice) => (
                  <TouchableOpacity
                    key={invoice.id}
                    onPress={() => navigation.navigate('InvoiceDetail', { invoice })}
                  >
                    <Card style={{ marginBottom: SPACING.s }}>
                      <Card.Content>
                        <Text style={s.rowTitle}>Invoice #{invoice.id}</Text>
                        <Text style={s.rowMeta}>
                          {invoice.invoice_date
                            ? new Date(invoice.invoice_date).toLocaleDateString()
                            : ''}
                        </Text>
                        <Text style={s.rowMeta}>
                          Amount: Rs {Number(invoice.total_amount || 0).toFixed(2)}
                        </Text>
                        <Text style={s.rowMeta}>Status: {invoice.status || 'unpaid'}</Text>
                      </Card.Content>
                    </Card>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={s.rowMeta}>No invoices yet.</Text>
              )}
            </SectionCard>
          </>
        )}

        {tab === 'profile' && (
          <>
            <Card style={s.card}>
            <Card.Content>
              <Text style={s.cardTitle}>Patient Details</Text>

              <View style={s.photoRow}>
                {profileDraft.photo_url ? (
                  <Image source={{ uri: profileDraft.photo_url }} style={s.photoPreview} />
                ) : (
                  <View style={s.photoPlaceholder}>
                    <Text style={s.rowMeta}>No photo</Text>
                  </View>
                )}
                <View style={s.photoBtnWrap}>
                  <Button
                    mode="outlined"
                    onPress={() => void pickProfilePhoto()}
                    loading={photoUploading}
                    disabled={photoUploading}
                    style={s.photoBtn}
                    contentStyle={s.btnContent}
                    labelStyle={s.secondaryBtnText}
                    hitSlop={HIT_SLOP}
                  >
                    {profileDraft.photo_url ? 'Change Photo' : 'Add Photo'}
                  </Button>
                  {!CLOUDINARY_UPLOAD_URL && (
                    <Text style={s.hintText}>
                      Cloudinary not configured — the picked image is stored locally as photo_url.
                    </Text>
                  )}
                </View>
              </View>

              <FormField
                label="Name"
                value={profileDraft.name}
                onChangeText={(v) => updateDraft(setProfileDraft, 'name', v)}
              />
              <FormField
                label="Email"
                value={profileDraft.email}
                onChangeText={(v) => updateDraft(setProfileDraft, 'email', v)}
                keyboardType="email-address"
              />
              <FormField
                label="Age"
                value={profileDraft.age}
                onChangeText={(v) => updateDraft(setProfileDraft, 'age', v)}
                keyboardType="numeric"
              />
              <FormField
                label="Sex"
                value={profileDraft.sex}
                onChangeText={(v) => updateDraft(setProfileDraft, 'sex', v)}
              />
              <FormField
                label="Address"
                value={profileDraft.address}
                onChangeText={(v) => updateDraft(setProfileDraft, 'address', v)}
              />
              <FormField
                label="Mobile"
                value={profileDraft.mobile}
                onChangeText={(v) => updateDraft(setProfileDraft, 'mobile', v)}
                keyboardType="phone-pad"
              />
              <Text style={s.maskedLine}>
                Aadhaar on file: {maskAadhaar(profile?.aadhar_number || profileDraft.aadhar_number)}
              </Text>
              <FormField
                label="Aadhaar (12 digits)"
                value={profileDraft.aadhar_number}
                onChangeText={(v) =>
                  updateDraft(setProfileDraft, 'aadhar_number', v.replace(/\D/g, '').slice(0, 12))
                }
                keyboardType="numeric"
              />
              <FormField
                label="Height (cm)"
                value={profileDraft.height_cm}
                onChangeText={(v) => updateDraft(setProfileDraft, 'height_cm', v)}
                keyboardType="numeric"
              />
              <FormField
                label="Weight (kg)"
                value={profileDraft.weight_kg}
                onChangeText={(v) => updateDraft(setProfileDraft, 'weight_kg', v)}
                keyboardType="numeric"
              />
              <FormField
                label="BP"
                value={profileDraft.bp}
                onChangeText={(v) => updateDraft(setProfileDraft, 'bp', v)}
              />
              <FormField
                label="SpO2"
                value={profileDraft.spo2}
                onChangeText={(v) => updateDraft(setProfileDraft, 'spo2', v)}
                keyboardType="numeric"
              />
              <Button
                mode="contained"
                onPress={() => void saveProfile()}
                loading={loading}
                disabled={loading}
                style={s.primaryBtn}
                contentStyle={s.btnContent}
                labelStyle={s.primaryBtnText}
                hitSlop={HIT_SLOP}
              >
                Save Profile
              </Button>
            </Card.Content>
          </Card>

          <Card style={[s.card, { marginTop: SPACING.m }]}>
            <Card.Content>
              <Text style={s.cardTitle}>Notifications & Alerts</Text>
              <View style={s.notifStatusRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <Ionicons
                    name={pushStatus.granted ? 'checkmark-circle' : 'alert-circle'}
                    size={22}
                    color={pushStatus.granted ? '#16a34a' : '#ea580c'}
                  />
                  <Text style={[s.notifStatusText, { color: pushStatus.granted ? '#16a34a' : '#ea580c' }]}>
                    {pushStatus.granted ? 'Push notifications active' : 'Notifications blocked'}
                  </Text>
                </View>
                {!pushStatus.granted && Platform.OS !== 'web' && (
                  <Button
                    mode="text"
                    compact
                    onPress={() => void import('../utils/pushRegistration').then((m) => m.openNotificationSettings())}
                  >
                    Settings
                  </Button>
                )}
              </View>

              <Text style={s.notifHelpText}>
                Receive alerts when your appointment is accepted, updated, or when prescriptions and bills are ready.
              </Text>

              <Button
                mode="outlined"
                loading={testingPush}
                disabled={testingPush}
                icon="bell-outline"
                onPress={async () => {
                  setTestingPush(true);
                  try {
                    const mod = await import('../utils/pushRegistration');
                    await mod.sendLocalTestNotification();
                    const srv = await mod.testServerPush(token);
                    if (srv.success) {
                      setInfoText('Test push sent! Check your notification bar.');
                    } else {
                      setErrorText(`Push test note: ${srv.message}`);
                    }
                  } catch (e: any) {
                    setErrorText(`Push test error: ${e?.message}`);
                  } finally {
                    setTestingPush(false);
                  }
                }}
                style={s.testPushBtn}
              >
                Send Test Notification
              </Button>
            </Card.Content>
          </Card>
        </>
      )}

        {tab === 'clinic' && (
          <>
            <Card style={s.heroCard} accessibilityLabel="Clinic information">
              <Card.Content>
                <Text style={s.heroEyebrow}>Our Clinic</Text>
                <Text style={s.heroTitle}>{CLINIC_DETAILS.name}</Text>
                <Text style={s.heroMeta}>{CLINIC_DETAILS.doctor}</Text>
                <Text style={s.heroMeta}>{CLINIC_DETAILS.specialty}</Text>
                <Text style={s.heroMeta}>{CLINIC_DETAILS.address}</Text>
                <Pressable
                  onPress={() => {
                    Linking.openURL(`tel:${CLINIC_DETAILS.mobile}`).catch(() =>
                      setErrorText(`Could not open dialer. Call ${CLINIC_DETAILS.mobile}`),
                    );
                  }}
                  hitSlop={HIT_SLOP}
                  accessibilityRole="link"
                  accessibilityLabel={`Call clinic at ${CLINIC_DETAILS.mobile}`}
                  style={({ pressed }) => [s.clinicPhoneRow, pressed && s.clinicPhonePressed]}
                >
                  <Ionicons name="call-outline" size={18} color={COLOR.surface} />
                  <Text style={s.clinicPhoneText}>{CLINIC_DETAILS.mobile}</Text>
                </Pressable>
              </Card.Content>
            </Card>

            <View style={s.clinicActions}>
              <Button
                mode="contained"
                onPress={() => {
                  Linking.openURL(`tel:${CLINIC_DETAILS.mobile}`).catch(() =>
                    setErrorText(`Could not open dialer. Call ${CLINIC_DETAILS.mobile}`),
                  );
                }}
                style={[s.primaryBtn, s.clinicActionBtn]}
                contentStyle={s.btnContent}
                labelStyle={s.primaryBtnText}
                hitSlop={HIT_SLOP}
                accessibilityLabel={`Call clinic at ${CLINIC_DETAILS.mobile}`}
              >
                Call Clinic
              </Button>
              <Button
                mode="outlined"
                onPress={() => {
                  const query = encodeURIComponent(CLINIC_DETAILS.address);
                  Linking.openURL(
                    `https://www.google.com/maps/search/?api=1&query=${query}`,
                  ).catch(() => setErrorText('Could not open maps. Please try again.'));
                }}
                style={[s.secondaryBtn, s.clinicActionBtn]}
                contentStyle={s.btnContent}
                labelStyle={s.secondaryBtnText}
                hitSlop={HIT_SLOP}
                accessibilityRole="link"
                accessibilityLabel={`Get directions to ${CLINIC_DETAILS.name}`}
              >
                Get Directions
              </Button>
            </View>

            <SectionCard title="Visiting Hours">
              <View style={s.clinicInfoRow}>
                <Ionicons name="time-outline" size={20} color={COLOR.primary} />
                <Text style={[s.rowMeta, s.clinicInfoText]}>
                  Call ahead to confirm today&apos;s timings.
                </Text>
              </View>
            </SectionCard>

            <SectionCard title="Why Patients Choose Us">
              <InfoList items={CLINIC_HIGHLIGHTS} icon="heart-outline" />
            </SectionCard>

            <SectionCard title="How to Use This App">
              <InfoList items={HOW_TO_USE} icon="phone-outline" />
            </SectionCard>

            <SectionCard title="Before You Visit">
              <InfoList items={BEFORE_VISIT} icon="location-outline" />
            </SectionCard>
          </>
        )}
      </ScrollView>

      <View style={s.bottomTabs}>
        <Tab tab="home" label="Home" active={tab === 'home'} onPress={() => setTab('home')} />
        <Tab tab="book" label="Book" active={tab === 'book'} onPress={() => setTab('book')} />
        <Tab tab="records" label="Records" active={tab === 'records'} onPress={() => setTab('records')} />
        <Tab tab="profile" label="Profile" active={tab === 'profile'} onPress={() => setTab('profile')} />
        <Tab tab="clinic" label="Clinic" active={tab === 'clinic'} onPress={() => setTab('clinic')} />
      </View>

      <Modal visible={showBookModal} transparent animationType="slide">
        <View style={s.modalWrap}>
          <Card style={s.modalCard}>
            <Card.Content>
              <Text style={s.cardTitle}>Book Appointment</Text>
              <Text style={s.cardMeta}>Open full booking to choose doctor, date, and notes.</Text>
              <Button
                mode="contained"
                onPress={() => {
                  setTab('book');
                  setShowBookModal(false);
                }}
                style={s.primaryBtn}
                contentStyle={s.btnContent}
                labelStyle={s.primaryBtnText}
                hitSlop={HIT_SLOP}
              >
                Open Booking
              </Button>
              <Button
                mode="outlined"
                onPress={() => setShowBookModal(false)}
                style={s.secondaryBtn}
                contentStyle={s.btnContent}
                labelStyle={s.secondaryBtnText}
                hitSlop={HIT_SLOP}
              >
                Close
              </Button>
            </Card.Content>
          </Card>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/**
 * Upload a local image URI to Cloudinary when configured; otherwise return
 * the local URI so the backend still stores it as `photo_url`.
 * Uses expo-file-system multipart upload: plain fetch() FormData file parts
 * ({uri,name,type} objects) are rejected on current RN ("Unsupported
 * FormDataPart implementation"), while the native uploader handles them.
 */
async function uploadPhotoAsync(localUri: string, mimeType?: string): Promise<string> {
  if (!CLOUDINARY_UPLOAD_URL) return localUri;
  const parameters: Record<string, string> = {};
  if (CLOUDINARY_UPLOAD_PRESET) parameters.upload_preset = CLOUDINARY_UPLOAD_PRESET;
  const result = await new File(localUri).upload(CLOUDINARY_UPLOAD_URL, {
    uploadType: UploadType.MULTIPART,
    fieldName: 'file',
    mimeType: mimeType || 'image/jpeg',
    parameters,
  });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error('Photo upload failed. Check your preset (must be Unsigned).');
  }
  let payload: any = null;
  try {
    payload = JSON.parse(String(result.body));
  } catch {
    throw new Error('Photo upload did not return a URL.');
  }
  if (payload?.error) throw new Error(payload.error?.message || 'Photo upload failed.');
  const url = payload?.secure_url || payload?.url;
  if (!url) throw new Error('Photo upload did not return a URL.');
  return String(url);
}

function updateDraft(
  setter: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  key: string,
  value: string,
) {
  setter((prev) => ({ ...prev, [key]: value }));
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={s.card}>
      <Card.Content>
        <Text style={s.cardTitle}>{title}</Text>
        {children}
      </Card.Content>
    </Card>
  );
}

function InfoList({ items, icon }: { items: string[]; icon?: string }) {
  return (
    <View>
      {items.map((item) => (
        <View key={item} style={s.clinicInfoRow}>
          {icon ? <Ionicons name={icon as any} size={20} color={COLOR.primary} /> : null}
          <Text style={[s.rowMeta, icon && s.clinicInfoText]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

// Minimal outline icons in theme tints: active = primary, inactive = accent.
const TAB_ICONS: Record<TabKey, { off: string; on: string }> = {
  home: { off: 'home-outline', on: 'home' },
  book: { off: 'calendar-outline', on: 'calendar' },
  records: { off: 'document-text-outline', on: 'document-text' },
  profile: { off: 'person-outline', on: 'person' },
  clinic: { off: 'business-outline', on: 'business' },
};

function Tab({ tab, label, active, onPress }: { tab: TabKey; label: string; active: boolean; onPress: () => void }) {
  const tint = active ? COLOR.primary : COLOR.accent;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={HIT_SLOP}
      pressRetentionOffset={HIT_SLOP}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      android_ripple={{ color: 'rgba(94,108,132,0.18)', borderless: false }}
      style={({ pressed }) => [s.tab, pressed && s.tabPressed]}
    >
      <Ionicons
        name={(active ? TAB_ICONS[tab].on : TAB_ICONS[tab].off) as any}
        size={22}
        color={tint}
      />
      <Text style={[s.tabText, active && s.tabActive]}>{label}</Text>
    </Pressable>
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

/** Surface express-validator `errors[]`, `{error}`, or `{message}` as readable text. */
function apiErrorMessage(payload: any, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  const first = Array.isArray(payload.errors) ? payload.errors[0] : null;
  const msg = first?.msg ?? first?.message;
  if (typeof msg === 'string' && msg.trim()) return msg;
  return fallback;
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
  avatarButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.s,
  },
  avatarImage: { width: 48, height: 48, borderRadius: 24, backgroundColor: COLOR.background },
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
  scrollBody: { paddingHorizontal: SPACING.l, paddingTop: SPACING.m, paddingBottom: 100 },
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
  hintText: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 12, marginTop: SPACING.xs },
  maskedLine: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 13, marginBottom: SPACING.xs },
  quickActions: { flexDirection: 'column', gap: SPACING.s, marginBottom: SPACING.m },
  metaRow: { flexDirection: 'row', gap: SPACING.s, marginVertical: SPACING.s },
  metaChip: { backgroundColor: COLOR.background },
  heroCard: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.lg,
    padding: SPACING.l,
    marginBottom: SPACING.m,
    ...SHADOW.card,
  },
  heroEyebrow: { color: COLOR.accent, fontFamily: FONT.medium, fontSize: 12, letterSpacing: 2, marginBottom: SPACING.s },
  heroTitle: { color: COLOR.surface, fontFamily: FONT.bold, fontSize: 22, marginBottom: SPACING.xs },
  heroMeta: { color: COLOR.surface, opacity: 0.85, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  heroChip: { backgroundColor: COLOR.surface },
  heroChipText: { color: COLOR.primary, fontFamily: FONT.medium },
  heroBtn: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.s,
  },
  heroBtnText: { color: COLOR.primary, fontFamily: FONT.bold, fontSize: 15 },
  attentionRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, paddingVertical: SPACING.s },
  attentionText: { flex: 1 },
  callStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.m,
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.m,
    marginBottom: SPACING.m,
  },
  callIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLOR.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clinicPhoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    marginTop: SPACING.s,
    paddingVertical: SPACING.s,
  },
  clinicPhonePressed: { opacity: 0.8 },
  clinicPhoneText: { color: COLOR.surface, fontFamily: FONT.bold, fontSize: 16 },
  clinicActions: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.m },
  clinicActionBtn: { flex: 1, marginTop: 0 },
  clinicInfoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.s,
    paddingVertical: SPACING.xs,
  },
  clinicInfoText: { flex: 1, marginTop: 0 },
  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s, marginBottom: SPACING.s },
  vitalTile: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: COLOR.background,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.m,
    alignItems: 'center',
  },
  vitalValue: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 18 },
  vitalLabel: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 12, marginTop: 2 },
  btnContent: { minHeight: 48, paddingVertical: 6 },
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
  priorityChip: { marginRight: SPACING.s, backgroundColor: COLOR.surface },
  priorityChipActive: { backgroundColor: COLOR.success },
  priorityText: { color: COLOR.primary },
  priorityTextActive: { color: '#FFFFFF' },
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
  rowTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 15 },
  rowMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 13, marginTop: SPACING.xs },
  photoRow: { flexDirection: 'row', gap: SPACING.m, alignItems: 'center', marginBottom: SPACING.m },
  photoBtnWrap: { flex: 1, justifyContent: 'center' },
  photoBtn: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.accent,
  },
  photoPreview: { width: 72, height: 72, borderRadius: 36, backgroundColor: COLOR.background },
  photoPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLOR.background,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLOR.accent,
  },
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
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRadius: RADIUS.md, gap: 2 },
  tabPressed: { opacity: 0.7, backgroundColor: 'rgba(94,108,132,0.12)' },
  tabText: { color: COLOR.accent, fontFamily: FONT.medium, fontSize: 11 },
  tabActive: { color: COLOR.primary, fontFamily: FONT.bold },
  infoText: {
    color: COLOR.success,
    fontFamily: FONT.medium,
    fontSize: 13,
    marginHorizontal: SPACING.l,
    marginBottom: SPACING.xs,
  },
  errorText: {
    color: COLOR.text,
    fontFamily: FONT.medium,
    fontSize: 13,
    marginHorizontal: SPACING.l,
    marginBottom: SPACING.xs,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: SPACING.l,
    marginBottom: SPACING.s,
    padding: SPACING.s,
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
  },
  offlineText: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 13 },
  modalWrap: {
    flex: 1,
    backgroundColor: 'rgba(47,52,65,0.28)',
    justifyContent: 'flex-end',
    padding: SPACING.l,
  },
  modalCard: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.l, ...SHADOW.card },
  notifWarningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: SPACING.l,
    marginBottom: SPACING.s,
    padding: SPACING.s,
    backgroundColor: '#fef3c7',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  notifWarningWrap: { flex: 1, marginHorizontal: SPACING.s },
  notifWarningTitle: { color: '#92400e', fontFamily: FONT.bold, fontSize: 13 },
  notifWarningSub: { color: '#b45309', fontFamily: FONT.regular, fontSize: 11, marginTop: 1 },
  notifStatusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.xs },
  notifStatusText: { fontFamily: FONT.medium, fontSize: 13, marginLeft: SPACING.xs },
  notifHelpText: { color: COLOR.accent, fontFamily: FONT.regular, fontSize: 12, marginBottom: SPACING.m },
  testPushBtn: { borderColor: COLOR.primary, borderRadius: RADIUS.md },
});
