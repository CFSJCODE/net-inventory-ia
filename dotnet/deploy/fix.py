import re
p='netinventoryctl'
s=open(p,encoding='utf-8').read()
BS='\'
s=s.replace("$/\x01/'", "$/"+BS+"1/'")
s=s.replace("Bearer %s\n'", "Bearer %s"+BS+"n'")
s=s.replace("%s min): %s\n'", "%s min): %s"+BS+"n'")
s=s.replace("application/json' "+BS+"n            -d", "application/json' "+BS+"\n            -d")
open(p,'w',encoding='utf-8',newline='').write(s)
