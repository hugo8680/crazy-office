package tools

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
)

func validateSchema(v any, s map[string]any, path string) error {
	types := stringsOf(s["type"])
	if name, ok := s["type"].(string); ok {
		types = []string{name}
	}
	matches := func(typ string) bool {
		switch typ {
		case "null":
			return v == nil
		case "object":
			_, ok := v.(map[string]any)
			return ok
		case "array":
			return v != nil && (reflect.TypeOf(v).Kind() == reflect.Slice || reflect.TypeOf(v).Kind() == reflect.Array)
		case "string":
			_, ok := v.(string)
			return ok
		case "boolean":
			_, ok := v.(bool)
			return ok
		case "integer", "number":
			switch v.(type) {
			case float64, float32, int, int64, int32, json.Number:
				n := number(v)
				return !math.IsNaN(n) && !math.IsInf(n, 0) && (typ != "integer" || n == math.Trunc(n))
			}
			return false
		}
		return true
	}
	if len(types) > 0 {
		ok := false
		for _, typ := range types {
			ok = ok || matches(typ)
		}
		if !ok {
			return fmt.Errorf("%s类型不符合工具定义", path)
		}
	}
	if values, ok := s["enum"].([]any); ok {
		found := false
		for _, x := range values {
			found = found || reflect.DeepEqual(v, x)
		}
		if !found {
			return fmt.Errorf("%s选项无效", path)
		}
	}
	if m, ok := v.(map[string]any); ok {
		properties, _ := s["properties"].(map[string]any)
		for _, name := range stringsOf(s["required"]) {
			if _, ok := m[name]; !ok {
				return fmt.Errorf("%s缺少%s", path, name)
			}
		}
		for k, value := range m {
			schema, known := properties[k].(map[string]any)
			if !known {
				if s["additionalProperties"] == false {
					return fmt.Errorf("%s包含未知字段%s", path, k)
				}
				continue
			}
			if e := validateSchema(value, schema, path+"."+k); e != nil {
				return e
			}
		}
	}
	if v != nil && (reflect.TypeOf(v).Kind() == reflect.Slice || reflect.TypeOf(v).Kind() == reflect.Array) {
		rv := reflect.ValueOf(v)
		if n, ok := s["maxItems"]; ok && rv.Len() > int(number(n)) {
			return fmt.Errorf("%s项数过多", path)
		}
		if schema, ok := s["items"].(map[string]any); ok {
			for i := 0; i < rv.Len(); i++ {
				if e := validateSchema(rv.Index(i).Interface(), schema, fmt.Sprintf("%s[%d]", path, i)); e != nil {
					return e
				}
			}
		}
	}
	if matches("number") {
		n := number(v)
		if min, ok := s["minimum"]; ok && n < number(min) {
			return fmt.Errorf("%s小于允许范围", path)
		}
		if max, ok := s["maximum"]; ok && n > number(max) {
			return fmt.Errorf("%s大于允许范围", path)
		}
	}
	return nil
}
