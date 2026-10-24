export function filterEmployeeRegister(employees,{search='',department='',workerType='',status=''}){
  const words=search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return employees.filter(employee=>{
    const text=[employee.name,employee.code,employee.department,employee.designation,employee.workerType]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word=>text.includes(word))&&(!department||employee.department===department)
      &&(!workerType||employee.workerType===workerType)&&(!status||employee.status===status);
  });
}
