
export enum FrequencyType {
  DISPATCH = '462.5625',
  RESCUE = '462.6125',
  TACTICAL = '462.6625'
}

export interface FrequencyConfig {
  name: string;
  value: FrequencyType;
  description: string;
  color: string;
}

export const FREQUENCIES: FrequencyConfig[] = [
  { name: 'CH 01', value: FrequencyType.DISPATCH, description: 'Base Dispatch', color: 'bg-blue-600' },
  { name: 'CH 02', value: FrequencyType.RESCUE, description: 'Search & Rescue', color: 'bg-orange-600' },
  { name: 'CH 03', value: FrequencyType.TACTICAL, description: 'Field Tactical', color: 'bg-red-600' }
];

export interface Message {
  sender: string;
  text: string;
  timestamp: Date;
  isUser: boolean;
}
