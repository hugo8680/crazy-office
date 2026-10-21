// Clothing identifies the kind of colleague in every renderer. Hair and skin
// remain independent; a department or permission never changes this identity.
export const EMPLOYEE_APPEARANCE=Object.freeze({
  virtual:Object.freeze({uniform:'#347f9c',trim:'#dceef3',badge:'#b9dce9'}),
  human:Object.freeze({uniform:'#c68b60',trim:'#f5e6cc',badge:'#f6efdf'}),
});

export function employeeAppearance(virtual=false){
  return EMPLOYEE_APPEARANCE[virtual?'virtual':'human'];
}
