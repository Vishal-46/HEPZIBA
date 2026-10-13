import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, View } from 'react-native';
import { Card, Text, Button } from 'react-native-paper';
import { COLOR, SPACING, FONT, RADIUS, SHADOW } from '../../theme';

export default function InvoiceDetailScreen({ route, navigation }: any) {
  const { invoice } = route.params;

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.content}>
        <Card style={s.card}>
          <Card.Content>
            <Text style={s.title}>Invoice #{invoice.id}</Text>
            <Text style={s.meta}>Date: {invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString() : 'N/A'}</Text>
            <Text style={s.meta}>Status: {invoice.status || 'unpaid'}</Text>
            
            <View style={s.divider} />
            
            <Text style={s.total}>Total Amount: Rs {Number(invoice.total_amount || 0).toFixed(2)}</Text>
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
  divider: { height: 1, backgroundColor: COLOR.background, marginVertical: SPACING.m },
  total: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 18, marginTop: SPACING.s },
  button: { marginTop: SPACING.l },
});
