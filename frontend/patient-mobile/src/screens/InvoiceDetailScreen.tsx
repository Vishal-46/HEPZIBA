import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, View, ActivityIndicator } from 'react-native';
import { Card, Text, Button } from 'react-native-paper';
import { COLOR, SPACING, FONT, RADIUS, SHADOW } from '../../theme';
import { API_BASE_URL } from '../config/api';
import { loadSession } from '../utils/tokenStore';

type Line = { medicine_name: string; quantity: number; mrp?: number | string; total?: number | string };

export default function InvoiceDetailScreen({ route, navigation }: any) {
  const { invoice } = route.params;
  const [lines, setLines] = useState<Line[] | null>(null);
  const [fee, setFee] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(invoice.status || 'unpaid');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const session = await loadSession();
        const res = await fetch(`${API_BASE_URL}/billing/invoices/${invoice.id}`, {
          headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        if (Array.isArray(data.items)) setLines(data.items);
        if (data.doctor_fee !== undefined) setFee(String(data.doctor_fee));
        if (data.status) setStatus(data.status);
      } catch {
        // Keep the summary the list screen already showed.
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  const medTotal = (lines ?? []).reduce((s, l) => s + Number(l.total ?? 0), 0);

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.content}>
        <Card style={s.card}>
          <Card.Content>
            <Text style={s.title}>Invoice #{invoice.id}</Text>
            <Text style={s.meta}>Date: {invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString() : 'N/A'}</Text>
            <Text style={s.meta}>Status: {status === 'paid' ? 'Paid ✓' : 'Unpaid — pay at the clinic'}</Text>

            <View style={s.divider} />
            <Text style={s.section}>Medicines</Text>
            {lines === null ? (
              <ActivityIndicator color={COLOR.primary} />
            ) : lines.length === 0 ? (
              <Text style={s.meta}>No medicine lines.</Text>
            ) : (
              lines.map((l, idx) => (
                <View key={idx} style={s.line}>
                  <Text style={s.lineName}>{l.medicine_name} × {l.quantity}</Text>
                  <Text style={s.lineAmt}>Rs {Number(l.total ?? 0).toFixed(2)}</Text>
                </View>
              ))
            )}

            <View style={s.divider} />
            <View style={s.line}>
              <Text style={s.lineName}>Medicines total</Text>
              <Text style={s.lineAmt}>Rs {medTotal.toFixed(2)}</Text>
            </View>
            <View style={s.line}>
              <Text style={s.lineName}>Doctor charge</Text>
              <Text style={s.lineAmt}>Rs {Number(fee ?? invoice.doctor_fee ?? 0).toFixed(2)}</Text>
            </View>
            <Text style={s.total}>Grand total: Rs {Number(invoice.total_amount || 0).toFixed(2)}</Text>
            {status !== 'paid' && (
              <Text style={s.meta}>Show this bill at reception to pay and close it.</Text>
            )}
          </Card.Content>
        </Card>
        <Button mode="contained" onPress={() => navigation.goBack()} style={s.button}>
          Go Back
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.background },
  content: { padding: SPACING.l },
  card: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.m, ...SHADOW.card },
  title: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 20, marginBottom: SPACING.m },
  meta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  section: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 16, marginBottom: SPACING.s },
  line: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: SPACING.xs },
  lineName: { color: COLOR.text, fontFamily: FONT.regular, fontSize: 14, flex: 1 },
  lineAmt: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 14 },
  divider: { height: 1, backgroundColor: COLOR.background, marginVertical: SPACING.m },
  total: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 18, marginTop: SPACING.s },
  button: { marginTop: SPACING.l },
});
