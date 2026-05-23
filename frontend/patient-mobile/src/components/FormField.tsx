import { StyleSheet, Text, TextInput, View } from 'react-native';
import { COLOR, FONT, RADIUS, SPACING } from '../../theme';

type Props = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'phone-pad';
  placeholder?: string;
  multiline?: boolean;
};

export default function FormField({
  label,
  value,
  onChangeText,
  keyboardType,
  placeholder,
  multiline,
}: Props) {
  return (
    <View style={s.wrap}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        placeholder={placeholder}
        placeholderTextColor={COLOR.accent}
        multiline={multiline}
        numberOfLines={multiline ? 4 : 1}
        style={[s.input, multiline && s.inputMultiline]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginBottom: SPACING.s,
  },
  label: {
    color: COLOR.text,
    fontFamily: FONT.medium,
    fontSize: 13,
    marginBottom: SPACING.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    backgroundColor: COLOR.background,
    color: COLOR.text,
    fontFamily: FONT.regular,
    paddingHorizontal: SPACING.m,
    paddingVertical: 12,
    fontSize: 14,
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
});
